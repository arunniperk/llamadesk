// Guards the fix for the Gemma "Conversation roles must alternate user/assistant" 400.
// A turn that produced no reply (stopped / errored) leaves two user messages in a row;
// strict-alternation templates reject that, so consecutive same-role messages are merged.
// Pure Node — the normalizer is exercised through agent.js's exported helper:
//   node scripts/test-convo-normalize.js
const path = require('path');

// agent.js pulls in electron-dependent modules, so load the helper in isolation by
// re-evaluating just the functions under test from source.
const fs = require('fs');
const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'main', 'agent.js'), 'utf8');
const start = src.indexOf('function mergeContent');
// end at the next top-level function after the normalizer, whatever follows it
const end = src.indexOf('function buildSystem', start);
if (start < 0 || end < 0 || end <= start) {
  console.log(`FAIL  could not locate the normalizer in agent.js (start=${start}, end=${end})`);
  process.exit(1);
}
// eslint-disable-next-line no-eval
const { normalizeConvo } = eval(`(() => { ${src.slice(start, end)} ; return { normalizeConvo }; })()`);

let failed = 0;
const check = (label, cond, extra) => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}${extra ? '  → ' + extra : ''}`);
  if (!cond) failed++;
};
const roles = (c) => c.map((m) => m.role).join(',');

const sys = { role: 'system', content: 'sys' };
const u = (t) => ({ role: 'user', content: t });
const a = (t) => ({ role: 'assistant', content: t });

// 1. the actual bug: an orphaned turn leaves user,user
let r = normalizeConvo([sys, u('first'), u('second')]);
check('merges consecutive user messages', roles(r) === 'system,user', roles(r));
check('keeps both texts', r[1].content.includes('first') && r[1].content.includes('second'), JSON.stringify(r[1].content));

// 2. proper alternation is left untouched
r = normalizeConvo([sys, u('a'), a('b'), u('c')]);
check('leaves alternating conversation alone', roles(r) === 'system,user,assistant,user', roles(r));

// 3. consecutive assistants merge too
r = normalizeConvo([u('q'), a('one'), a('two')]);
check('merges consecutive assistant messages', roles(r) === 'user,assistant', roles(r));

// 4. image content parts survive the merge
const withImg = { role: 'user', content: [{ type: 'text', text: 'look' }, { type: 'image_url', image_url: { url: 'data:image/png;base64,AAA' } }] };
r = normalizeConvo([u('before'), withImg]);
check('merged result is a content-part array', Array.isArray(r[0].content), typeof r[0].content);
check('image part preserved through merge', r[0].content.some((p) => p.type === 'image_url'), JSON.stringify(r[0].content.map((p) => p.type)));
check('text part preserved through merge', r[0].content.some((p) => p.type === 'text' && /before/.test(p.text)));

// 5. tool_calls must never be merged away — the tool loop depends on them
const withCalls = { role: 'assistant', content: null, tool_calls: [{ id: 'c1', type: 'function', function: { name: 'f', arguments: '{}' } }] };
r = normalizeConvo([u('q'), withCalls, { role: 'tool', tool_call_id: 'c1', content: 'res' }, a('done')]);
check('tool_calls message kept separate', roles(r) === 'user,assistant,tool,assistant', roles(r));
check('tool_calls survive intact', r[1].tool_calls && r[1].tool_calls.length === 1);

// 6. an assistant carrying tool_calls is not merged into a following assistant
r = normalizeConvo([withCalls, a('text')]);
check('assistant+tool_calls not merged with plain assistant', roles(r) === 'assistant,assistant', roles(r));

// 7. degenerate inputs
check('empty conversation survives', normalizeConvo([]).length === 0);
r = normalizeConvo([u('only')]);
check('single message unchanged', roles(r) === 'user' && r[0].content === 'only');

console.log(failed ? `\n${failed} FAILED` : '\nall checks passed');
process.exit(failed ? 1 : 0);
