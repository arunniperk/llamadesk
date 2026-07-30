'use strict';
// Chat + agent loop against the local llama-server OpenAI-compatible API.
// Streams text deltas to the renderer; executes built-in and MCP tool calls.
const os = require('os');
const tools = require('./tools');
const { manager: mcp } = require('./mcp');
const skills = require('./skills');
const monitor = require('./monitor');
const providers = require('./providers');

const SYSTEM_PROMPTS = {
  chat: `You are LlamaDesk, a helpful AI assistant running fully locally on the user's Windows 11 PC (Ryzen 7 5800X, 64 GB RAM, Radeon RX 9070 XT). Be concise, accurate and friendly. Use markdown for formatting and code blocks where useful.`,
  desktop: `You are LlamaDesk Desktop Agent, an AI operating the user's Windows 11 PC with their permission. You can run PowerShell, read/write files, list directories and fetch URLs via tools{MCP}. Think step by step: inspect before you modify, verify results after acting, and report exactly what you did. Prefer non-destructive approaches; state clearly when a command could delete or overwrite data.{ADMIN}`,
  coding: `You are LlamaDesk Coding Agent, an expert software engineer working on the user's Windows 11 machine. You can run PowerShell (git, npm, compilers, tests), read/write/edit files and fetch URLs via tools{MCP}. Workflow: understand the code first (read files, list directories), make minimal correct changes, then verify by running builds or tests. Show diffs or key snippets of what you changed. Never fabricate file contents — always read before editing.{ADMIN}`,
};

// First positive number among the candidates; 0/undefined means "not reported".
const firstNum = (...vals) => {
  for (const v of vals) if (typeof v === 'number' && v > 0) return v;
  return 0;
};

function buildSystem(mode, settings, online) {
  let base = SYSTEM_PROMPTS[mode] || SYSTEM_PROMPTS.chat;
  if (online) base = base.replace('running fully locally on', 'accessed from LlamaDesk on');
  const mcpTools = mcp.toolDefs();
  base = base.replace('{MCP}', mcpTools.length
    ? `, plus ${mcpTools.length} MCP extension tools (prefixed mcp__)`
    : '');
  base = base.replace('{ADMIN}', settings.adminMode
    ? ' The app is running elevated (Administrator) — system-level changes are permitted, but double-check destructive commands before running them.'
    : ' The app is NOT elevated; commands needing admin rights will fail (the user can enable Admin Mode in the top bar).');
  base += `\nCurrent date: ${new Date().toDateString()}. User home: ${os.homedir()}.`;
  if (mode !== 'chat') base += skills.buildPrompt(settings.skillsEnabled);
  return base;
}

class Agent {
  constructor() {
    this.abort = null;
    this.running = false;
  }

  stop() {
    if (this.abort) this.abort.abort();
  }

  // emit: (event, payload) => void  — forwards to renderer
  // target: null/{kind:'local'} for llama-server, or {kind:'online', provider, model}
  async run({ messages, mode, settings, target }, emit) {
    if (this.running) throw new Error('A response is already in progress.');
    this.running = true;
    this.abort = new AbortController();
    const signal = this.abort.signal;
    const online = target && target.kind === 'online';
    let url = `http://127.0.0.1:${settings.port}/v1/chat/completions`;
    let headers = { 'Content-Type': 'application/json' };
    let modelId = 'local';
    if (online) {
      const p = providers.resolve(settings, target.provider);
      url = p.baseUrl + '/chat/completions';
      headers = { ...headers, ...providers.authHeaders(target.provider, p.key) };
      modelId = target.model;
    }
    const useTools = mode !== 'chat';
    const toolDefs = useTools ? [...tools.DEFS, ...mcp.toolDefs().map(({ _server, _tool, ...d }) => d)] : undefined;

    const convo = [{ role: 'system', content: buildSystem(mode, settings, online) }, ...messages];
    let tokensIn = 0;     // prompt tokens consumed, summed over tool-call round-trips
    let tokensOut = 0;    // completion tokens generated, ditto
    let roundChunks = 0;  // chunks of the in-flight round-trip (hoisted for the abort path)
    let exact = true;     // false once any round-trip falls back to chunk counting
    const t0 = Date.now();

    try {
      for (let iter = 0; iter < 32; iter++) {
        const body = {
          model: modelId,
          messages: convo,
          stream: true,
          temperature: settings.temperature,
        };
        if (toolDefs && toolDefs.length) body.tools = toolDefs;
        // llama-server reports counts via `timings`; OpenAI-compatible providers only
        // append a final usage chunk when asked to.
        if (online) body.stream_options = { include_usage: true };

        const res = await fetch(url, {
          method: 'POST',
          headers,
          body: JSON.stringify(body),
          signal,
        });
        if (!res.ok) {
          const errText = await res.text().catch(() => '');
          const who = online ? `${target.provider} API` : 'llama-server';
          throw new Error(`${who} HTTP ${res.status}: ${errText.slice(0, 400)}`);
        }

        // ---- consume SSE stream ----
        let content = '';
        let reasoning = '';
        const toolCalls = []; // accumulated by index
        let finishReason = null;
        let timings = null;
        let usage = null;
        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let sseBuf = '';
        let lastTick = Date.now();
        let tickTokens = 0;
        roundChunks = 0;

        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          sseBuf += decoder.decode(value, { stream: true });
          let nl;
          while ((nl = sseBuf.indexOf('\n')) >= 0) {
            const line = sseBuf.slice(0, nl).trim();
            sseBuf = sseBuf.slice(nl + 1);
            if (!line.startsWith('data:')) continue;
            const data = line.slice(5).trim();
            if (data === '[DONE]') continue;
            let obj;
            try { obj = JSON.parse(data); } catch { continue; }
            if (obj.timings) timings = obj.timings;
            // the usage chunk carries an empty choices array — read it before the guard below
            if (obj.usage) usage = obj.usage;
            const choice = obj.choices && obj.choices[0];
            if (!choice) continue;
            if (choice.finish_reason) finishReason = choice.finish_reason;
            const delta = choice.delta || {};
            if (delta.reasoning_content) {
              reasoning += delta.reasoning_content;
              emit('thinking', { text: delta.reasoning_content });
            }
            if (delta.content) {
              content += delta.content;
              tickTokens++;
              roundChunks++;
              emit('delta', { text: delta.content });
            }
            if (delta.tool_calls) {
              for (const tc of delta.tool_calls) {
                const i = tc.index ?? 0;
                if (!toolCalls[i]) toolCalls[i] = { id: tc.id || `call_${iter}_${i}`, type: 'function', function: { name: '', arguments: '' } };
                if (tc.id) toolCalls[i].id = tc.id;
                if (tc.function?.name) toolCalls[i].function.name += tc.function.name;
                if (tc.function?.arguments) toolCalls[i].function.arguments += tc.function.arguments;
              }
            }
            const now = Date.now();
            if (now - lastTick >= 1000) {
              monitor.setTokps(Math.round((tickTokens / ((now - lastTick) / 1000)) * 10) / 10);
              monitor.setLiveTokens(roundChunks);
              lastTick = now;
              tickTokens = 0;
            }
          }
        }

        // ---- token accounting for this round-trip ----
        // Exact counts come from the provider (`usage`) or llama-server (`timings`);
        // chunk counting is the last resort. A tool-calling turn makes several
        // round-trips and re-sends the whole conversation each time, so both totals
        // are sums over the round-trips, not a single request's numbers.
        const roundOut = firstNum(usage && usage.completion_tokens, timings && timings.predicted_n, roundChunks);
        const roundIn = firstNum(usage && usage.prompt_tokens, timings && timings.prompt_n);
        if (!usage && !(timings && timings.predicted_n)) exact = false;
        tokensIn += roundIn;
        tokensOut += roundOut;
        monitor.commitTokens(roundIn, roundOut);
        roundChunks = 0; // committed — don't let the abort path count it twice

        const tokps = timings && timings.predicted_per_second
          ? Math.round(timings.predicted_per_second * 10) / 10
          : null;
        emit('timings', {
          tokps,
          promptTokps: timings ? Math.round((timings.prompt_per_second || 0) * 10) / 10 : 0,
          tokens: tokensOut,
          tokensIn,
          tokensOut,
          exact,
        });
        if (tokps) monitor.setTokps(tokps);

        const cleanCalls = toolCalls.filter(Boolean);
        if (finishReason === 'tool_calls' || (cleanCalls.length && !content)) {
          const assistantMsg = { role: 'assistant', content: content || null, tool_calls: cleanCalls };
          convo.push(assistantMsg);
          for (const tc of cleanCalls) {
            let args = {};
            try { args = JSON.parse(tc.function.arguments || '{}'); } catch { /* model emitted bad JSON */ }
            emit('tool_start', { id: tc.id, name: tc.function.name, args });
            let result;
            try {
              result = tc.function.name.startsWith('mcp__')
                ? await mcp.call(tc.function.name, args)
                : await tools.call(tc.function.name, args);
            } catch (err) {
              result = 'TOOL ERROR: ' + String(err.message || err);
            }
            if (typeof result !== 'string') result = JSON.stringify(result);
            emit('tool_end', { id: tc.id, name: tc.function.name, result: result.slice(0, 4000) });
            convo.push({ role: 'tool', tool_call_id: tc.id, content: result });
          }
          continue; // next round-trip with tool results
        }

        // final answer
        emit('done', {
          content,
          seconds: Math.round(((Date.now() - t0) / 1000) * 10) / 10,
          tokens: tokensOut,
          tokensIn,
          tokensOut,
          exact,
        });
        monitor.setTokps(0);
        return;
      }
      emit('done', {
        content: '(stopped: tool-call loop exceeded 32 iterations)',
        seconds: 0, tokens: tokensOut, tokensIn, tokensOut, exact,
      });
    } catch (err) {
      monitor.setTokps(0);
      // the interrupted round-trip never reported usage — keep its chunk count
      tokensOut += roundChunks;
      monitor.commitTokens(0, roundChunks);
      if (signal.aborted) emit('done', { content: null, aborted: true, tokens: tokensOut, tokensIn, tokensOut, exact: false });
      else emit('error', { message: String(err.message || err) });
    } finally {
      this.running = false;
      this.abort = null;
    }
  }
}

module.exports = new Agent();
