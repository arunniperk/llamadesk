// Runtime check for token accounting in agent.js + monitor.js.
// A fake OpenAI-compatible SSE server replays scripted streams (llama-server
// timings, provider usage chunk, no-usage fallback, multi-round tool calls) and
// we assert on the tokensIn/tokensOut the agent reports.
// Run with: npx electron scripts/test-tokens.js
const { app } = require('electron');
const http = require('http');
const path = require('path');
const fs = require('fs');

let failed = 0;
const check = (label, cond, extra) => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}${extra ? '  → ' + extra : ''}`);
  if (!cond) failed++;
};

// ---- fake server: each request shifts one scripted stream off the queue ----
const queue = [];
const seenBodies = [];
const sse = (res, obj) => res.write(`data: ${JSON.stringify(obj)}\n\n`);
const chunk = (delta) => ({ choices: [{ index: 0, delta }] });

const server = http.createServer((req, res) => {
  let raw = '';
  req.on('data', (d) => { raw += d; });
  req.on('end', () => {
    seenBodies.push(JSON.parse(raw || '{}'));
    const script = queue.shift() || [];
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    for (const ev of script) sse(res, ev);
    res.write('data: [DONE]\n\n');
    res.end();
  });
});

// collect the agent's emitted events for one run
async function run(agent, opts) {
  const events = {};
  await agent.run(opts, (name, payload) => {
    if (name === 'done' || name === 'timings' || name === 'error') events[name] = payload;
  });
  return events;
}

app.whenReady().then(async () => {
  const src = (m) => require(path.join(__dirname, '..', 'src', 'main', m));
  const agent = src('agent.js');
  const monitor = src('monitor.js');
  const providers = src('providers.js');

  const keysFile = path.join(app.getPath('userData'), 'keys.json');
  const backup = fs.existsSync(keysFile) ? fs.readFileSync(keysFile) : null;

  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  const base = { temperature: 0.7, port, skillsEnabled: [], adminMode: false };
  const msgs = [{ role: 'user', content: 'hi' }];

  try {
    // ---- 1. local llama-server: timings carry the exact counts ----
    queue.push([
      chunk({ content: 'a' }), chunk({ content: 'b' }), chunk({ content: 'c' }),
      { timings: { prompt_n: 1000, predicted_n: 42, prompt_per_second: 500, predicted_per_second: 33.3 },
        choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] },
    ]);
    let ev = await run(agent, { messages: msgs, mode: 'chat', settings: base, target: null });
    check('local: no error', !ev.error, ev.error && ev.error.message);
    check('local: generated = timings.predicted_n (not chunk count)', ev.done.tokensOut === 42, String(ev.done.tokensOut));
    check('local: consumed = timings.prompt_n', ev.done.tokensIn === 1000, String(ev.done.tokensIn));
    check('local: marked exact', ev.done.exact === true);
    check('local: tokps from timings', ev.timings.tokps === 33.3, String(ev.timings.tokps));
    check('monitor cumulative after run 1', monitor.tokensIn === 1000 && monitor.tokensOut === 42,
      `${monitor.tokensIn}/${monitor.tokensOut}`);
    check('monitor live counter cleared', monitor.liveOut === 0);

    // ---- 2. no usage and no timings: fall back to chunk counting, flagged ----
    queue.push([chunk({ content: 'x' }), chunk({ content: 'y' }), chunk({ content: 'z' })]);
    ev = await run(agent, { messages: msgs, mode: 'chat', settings: base, target: null });
    check('fallback: generated = chunk count', ev.done.tokensOut === 3, String(ev.done.tokensOut));
    check('fallback: consumed unknown = 0', ev.done.tokensIn === 0, String(ev.done.tokensIn));
    check('fallback: marked approximate', ev.done.exact === false);

    // ---- 3. online provider: usage chunk (empty choices) must be read ----
    providers.setKey('faketest', 'sk-fake-key');
    const onlineSettings = {
      ...base,
      providers: { faketest: { label: 'Fake', baseUrl: `http://127.0.0.1:${port}/v1`, models: ['m1'], enabled: true } },
    };
    queue.push([
      chunk({ content: 'hello' }), chunk({ content: ' world' }),
      { choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] },
      { choices: [], usage: { prompt_tokens: 80, completion_tokens: 20, total_tokens: 100 } },
    ]);
    seenBodies.length = 0;
    ev = await run(agent, {
      messages: msgs, mode: 'chat', settings: onlineSettings,
      target: { kind: 'online', provider: 'faketest', model: 'm1' },
    });
    check('online: no error', !ev.error, ev.error && ev.error.message);
    check('online: requested usage in stream', seenBodies[0].stream_options
      && seenBodies[0].stream_options.include_usage === true, JSON.stringify(seenBodies[0].stream_options));
    check('online: generated = usage.completion_tokens', ev.done.tokensOut === 20, String(ev.done.tokensOut));
    check('online: consumed = usage.prompt_tokens', ev.done.tokensIn === 80, String(ev.done.tokensIn));
    check('online: marked exact', ev.done.exact === true);

    // ---- 4. tool-call turn: both totals sum over the round-trips ----
    queue.push([
      { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: 'c1', function: { name: 'no_such_tool', arguments: '{}' } }] },
        finish_reason: 'tool_calls' }],
        timings: { prompt_n: 100, predicted_n: 10, predicted_per_second: 20 } },
    ]);
    queue.push([
      chunk({ content: 'done' }),
      { timings: { prompt_n: 150, predicted_n: 20, predicted_per_second: 25 },
        choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] },
    ]);
    const beforeIn = monitor.tokensIn, beforeOut = monitor.tokensOut;
    ev = await run(agent, { messages: msgs, mode: 'desktop', settings: base, target: null });
    check('tool loop: no error', !ev.error, ev.error && ev.error.message);
    check('tool loop: consumed summed over both round-trips', ev.done.tokensIn === 250, String(ev.done.tokensIn));
    check('tool loop: generated summed over both round-trips', ev.done.tokensOut === 30, String(ev.done.tokensOut));
    check('tool loop: monitor added the same totals once',
      monitor.tokensIn - beforeIn === 250 && monitor.tokensOut - beforeOut === 30,
      `${monitor.tokensIn - beforeIn}/${monitor.tokensOut - beforeOut}`);

    // ---- 5. the stats broadcast the renderer consumes carries both fields ----
    const stats = await new Promise((resolve) => {
      const off = monitor.onStats((s) => { off(); resolve(s); });
      monitor.start();
    });
    monitor.stop();
    check('monitor stats expose tokensIn/tokensOut',
      typeof stats.tokensIn === 'number' && typeof stats.tokensOut === 'number',
      `${stats.tokensIn}/${stats.tokensOut}`);
  } catch (err) {
    check('unexpected exception', false, String(err && err.stack || err));
  } finally {
    providers.removeKey && providers.removeKey('faketest');
    if (backup) fs.writeFileSync(keysFile, backup);
    else if (fs.existsSync(keysFile)) fs.unlinkSync(keysFile);
    server.close();
  }

  console.log(failed ? `\n${failed} FAILED` : '\nall checks passed');
  app.exit(failed ? 1 : 0);
});
