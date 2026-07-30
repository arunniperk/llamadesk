'use strict';
/* global api */
const $ = (id) => document.getElementById(id);
const el = (tag, cls, text) => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
};

const state = {
  settings: null,
  models: [],
  suggestions: {},
  selectedModel: null,
  loadedModel: null,
  target: null, // null = local llama-server; {kind:'online', provider, model, label}
  providers: [],
  mode: 'chat',
  history: [], // OpenAI messages of current conversation
  streaming: false,
  sparkData: new Array(60).fill(0),
};

// ---------------- toast ----------------
let toastTimer = null;
function toast(msg, isErr) {
  const t = $('toast');
  t.textContent = msg;
  t.className = 'toast' + (isErr ? ' err' : '');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.add('hidden'), isErr ? 6000 : 3000);
}

// ---------------- markdown (minimal, safe) ----------------
function escapeHtml(s) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
function renderMarkdown(md) {
  const blocks = md.split(/```/);
  let html = '';
  for (let i = 0; i < blocks.length; i++) {
    if (i % 2 === 1) {
      const nl = blocks[i].indexOf('\n');
      const code = nl >= 0 ? blocks[i].slice(nl + 1) : blocks[i];
      html += `<pre><code>${escapeHtml(code)}</code></pre>`;
    } else {
      let t = escapeHtml(blocks[i]);
      t = t.replace(/`([^`\n]+)`/g, '<code>$1</code>');
      t = t.replace(/\*\*([^*\n]+)\*\*/g, '<b>$1</b>');
      t = t.replace(/^### (.+)$/gm, '<h3>$1</h3>');
      t = t.replace(/^## (.+)$/gm, '<h2>$1</h2>');
      t = t.replace(/^# (.+)$/gm, '<h1>$1</h1>');
      t = t.replace(/^[-*] (.+)$/gm, '<li>$1</li>');
      t = t.replace(/(<li>[\s\S]*?<\/li>)(?!\s*<li>)/g, '<ul>$1</ul>');
      t = t.replace(/\[([^\]]+)\]\((https?:[^)]+)\)/g, '<a href="$2" target="_blank">$1</a>');
      const paras = t.split(/\n{2,}/).map((p) => {
        const trimmed = p.trim();
        if (!trimmed) return '';
        if (/^<(h\d|ul|pre)/.test(trimmed)) return trimmed;
        return '<p>' + trimmed.replace(/\n/g, '<br>') + '</p>';
      });
      html += paras.join('');
    }
  }
  return html;
}

// ---------------- telemetry ----------------
const fmtGB = (b) => (b / 1024 ** 3).toFixed(1) + ' GB';
// used/total sharing one unit — keeps these tiles on a single line now that the
// telemetry row carries a sixth stat
const fmtPairGB = (used, total) => (used / 1024 ** 3).toFixed(1) + ' / ' + fmtGB(total);
const fmtNum = (n) => (n >= 100000 ? Math.round(n / 1000) + 'k' : n.toLocaleString('en-US'));
function drawSpark() {
  const c = $('spark');
  const ctx = c.getContext('2d');
  ctx.clearRect(0, 0, c.width, c.height);
  const max = Math.max(10, ...state.sparkData);
  ctx.beginPath();
  state.sparkData.forEach((v, i) => {
    const x = (i / (state.sparkData.length - 1)) * c.width;
    const y = c.height - (v / max) * (c.height - 3) - 1;
    i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
  });
  const grad = ctx.createLinearGradient(0, 0, c.width, 0);
  grad.addColorStop(0, '#7c5cff');
  grad.addColorStop(1, '#22d3ee');
  ctx.strokeStyle = grad;
  ctx.lineWidth = 1.6;
  ctx.stroke();
}
api.monitor.onStats((s) => {
  $('st-cpu').textContent = s.cpu.toFixed(0) + '%';
  $('bar-cpu').style.width = s.cpu + '%';
  $('st-ram').textContent = fmtPairGB(s.ramUsed, s.ramTotal);
  $('bar-ram').style.width = (s.ramUsed / s.ramTotal) * 100 + '%';
  $('st-gpu').textContent = s.gpu.toFixed(0) + '%';
  $('bar-gpu').style.width = s.gpu + '%';
  if (s.vramTotal > 0) {
    $('st-vram').textContent = fmtPairGB(s.vramUsed, s.vramTotal);
    $('bar-vram').style.width = (s.vramUsed / s.vramTotal) * 100 + '%';
  } else {
    $('st-vram').textContent = fmtGB(s.vramUsed);
  }
  $('st-tokens-in').textContent = fmtNum(s.tokensIn || 0);
  $('st-tokens-out').textContent = fmtNum(s.tokensOut || 0);
  $('st-tokps').textContent = s.tokps ? s.tokps.toFixed(1) : '0';
  state.sparkData.push(s.tokps || 0);
  state.sparkData.shift();
  drawSpark();
});

// ---------------- models sidebar ----------------
async function rescanModels() {
  const { models, suggestions } = await api.models.scan();
  state.models = models;
  state.suggestions = suggestions;
  renderModelList();
  renderSuggestions();
}

function renderSuggestions() {
  const box = $('suggestions');
  box.innerHTML = '';
  const rows = [
    ['Chat', state.suggestions.chat],
    ['Coding', state.suggestions.coding],
    ['Agent', state.suggestions.agent],
  ];
  for (const [kind, m] of rows) {
    if (!m) continue;
    const d = el('div', 'sugg');
    const k = el('span', 'sugg-kind', kind + ':');
    d.appendChild(k);
    d.appendChild(document.createTextNode(' '));
    const b = el('b', '', m.name.length > 26 ? m.name.slice(0, 26) + '…' : m.name);
    d.appendChild(b);
    d.title = `Suggested for ${kind.toLowerCase()}: ${m.file}\n${m.advice.fitNote}`;
    d.onclick = () => selectModel(m.path, true);
    box.appendChild(d);
  }
}

function renderModelList() {
  const list = $('model-list');
  list.innerHTML = '';
  if (!state.models.length) {
    list.appendChild(el('div', 'empty-hint')).innerHTML =
      'No GGUF models found.<br/>Add a folder with ＋ above.';
    return;
  }
  for (const m of state.models) {
    const card = el('div', 'model-card' + (state.selectedModel === m.path ? ' active' : ''));
    card.appendChild(el('div', 'model-name', m.name));
    const meta = el('div', 'model-meta');
    meta.appendChild(el('span', '', fmtGB(m.sizeBytes)));
    if (m.quant) meta.appendChild(el('span', '', m.quant));
    if (m.arch) meta.appendChild(el('span', '', m.arch));
    if (m.contextLength) meta.appendChild(el('span', '', (m.contextLength / 1024) + 'k ctx'));
    card.appendChild(meta);
    const badges = el('div', 'badges');
    const fitBadge = el('span', 'badge fit-' + m.advice.fit,
      m.advice.fit === 'gpu' ? '✓ fits VRAM' : m.advice.fit === 'hybrid' ? '◐ GPU+RAM' : '✗ too big');
    fitBadge.title = m.advice.fitNote;
    badges.appendChild(fitBadge);
    for (const u of m.advice.uses.slice(0, 2)) badges.appendChild(el('span', 'badge use', u));
    card.appendChild(badges);
    if (state.selectedModel === m.path) {
      const btn = el('button', 'btn primary small model-load',
        state.loadedModel === m.path ? '⏏ Unload' : '▶ Load model');
      btn.onclick = (e) => { e.stopPropagation(); state.loadedModel === m.path ? unloadModel() : loadModel(m.path); };
      card.appendChild(btn);
    }
    card.onclick = () => selectModel(m.path);
    card.title = m.path;
    list.appendChild(card);
  }
}

function selectModel(p, andLoad) {
  state.selectedModel = p;
  state.target = null; // back to local
  renderModelList();
  renderOnlineList();
  refreshPill();
  if (andLoad) loadModel(p);
}

// ---------------- online models (v2) ----------------
async function refreshProviders() {
  state.providers = await api.providers.list();
  renderOnlineList();
}
function renderOnlineList() {
  const box = $('online-list');
  box.innerHTML = '';
  const active = state.providers.filter((p) => p.enabled && p.hasKey);
  if (!active.length) {
    const hint = el('div', 'empty-hint small');
    hint.innerHTML = 'Add API keys in Settings → Providers<br/>(DeepSeek, OpenAI, OpenRouter…)';
    box.appendChild(hint);
    return;
  }
  for (const p of active) {
    for (const model of p.models) {
      const isSel = state.target && state.target.provider === p.name && state.target.model === model;
      const card = el('div', 'model-card online' + (isSel ? ' active' : ''));
      card.appendChild(el('div', 'model-name', model));
      const badges = el('div', 'badges');
      badges.appendChild(el('span', 'badge provider', p.label));
      if (/reasoner|r1|o[134]|thinking/i.test(model)) badges.appendChild(el('span', 'badge use', 'Reasoning'));
      badges.appendChild(el('span', 'badge use', 'Tools OK'));
      card.appendChild(badges);
      card.onclick = () => {
        state.target = { kind: 'online', provider: p.name, model, label: p.label };
        state.selectedModel = null;
        renderModelList();
        renderOnlineList();
        refreshPill();
      };
      card.title = `${p.label} · ${model}`;
      box.appendChild(card);
    }
  }
}
function refreshPill() {
  if (state.target && state.target.kind === 'online') {
    setServerPill('on', `☁ ${state.target.label} · ${state.target.model}`);
  } else if (state.loadedModel) {
    setServerPill('on', state.loadedModel.split('\\').pop());
  } else {
    setServerPill('off', 'No model loaded');
  }
}

async function loadModel(p) {
  try {
    setServerPill('starting', 'Loading ' + p.split('\\').pop() + '…');
    await api.llama.start(p);
    state.loadedModel = p;
    renderModelList();
  } catch (err) {
    toast(String(err.message || err).replace(/^Error invoking remote method '[^']+': Error: /, ''), true);
    setServerPill('off', 'No model loaded');
  }
}
async function unloadModel() {
  await api.llama.stop();
  state.loadedModel = null;
  renderModelList();
}

function setServerPill(cls, text) {
  const pill = $('server-pill');
  pill.className = 'server-pill ' + cls;
  $('server-pill-text').textContent = text;
}
api.llama.onState((st) => {
  const onlineSelected = state.target && state.target.kind === 'online';
  if (st.running) {
    state.loadedModel = st.model;
    if (!onlineSelected) setServerPill('on', st.model ? st.model.split('\\').pop() + '  ·  port ' + st.port : 'Running');
  } else if (st.starting) {
    if (!onlineSelected) setServerPill('starting', 'Starting llama-server…');
  } else {
    state.loadedModel = null;
    if (!onlineSelected) setServerPill('off', st.error ? 'Server stopped — see log' : 'No model loaded');
  }
  renderModelList();
  const log = $('server-log');
  if (st.log && st.log.length) { log.textContent = st.log.join('\n'); log.scrollTop = log.scrollHeight; }
  if (st.error) toast(st.error, true);
});

// ---------------- chat ----------------
let curAssistant = null; // { bubble, contentEl, thinkingEl, raw }
function addUserMsg(text) {
  clearWelcome();
  const m = el('div', 'msg user');
  m.appendChild(el('div', 'who', 'You'));
  m.appendChild(el('div', 'bubble', text));
  $('messages').appendChild(m);
  scrollBottom();
}
function clearWelcome() {
  const w = document.querySelector('.welcome');
  if (w) w.remove();
}
function startAssistantMsg() {
  const m = el('div', 'msg assistant');
  let modeName = { chat: 'Assistant', desktop: 'Desktop Agent', coding: 'Coding Agent' }[state.mode];
  if (state.target && state.target.kind === 'online') modeName += ' · ' + state.target.model;
  m.appendChild(el('div', 'who', modeName));
  const bubble = el('div', 'bubble');
  const contentEl = el('div');
  contentEl.appendChild(el('span', 'cursor'));
  bubble.appendChild(contentEl);
  m.appendChild(bubble);
  const meta = el('div', 'meta', '');
  m.appendChild(meta);
  $('messages').appendChild(m);
  curAssistant = { bubble, contentEl, meta, raw: '', thinkingEl: null };
  scrollBottom();
}
function scrollBottom() {
  const box = $('messages');
  box.scrollTop = box.scrollHeight;
}

api.chat.onThinking(({ text }) => {
  if (!curAssistant) return;
  if (!curAssistant.thinkingEl) {
    curAssistant.thinkingEl = el('div', 'thinking-block');
    curAssistant.bubble.insertBefore(curAssistant.thinkingEl, curAssistant.contentEl);
  }
  curAssistant.thinkingEl.textContent += text;
  curAssistant.thinkingEl.scrollTop = curAssistant.thinkingEl.scrollHeight;
});
api.chat.onDelta(({ text }) => {
  if (!curAssistant) return;
  curAssistant.raw += text;
  curAssistant.contentEl.innerHTML = renderMarkdown(curAssistant.raw) + '<span class="cursor"></span>';
  scrollBottom();
});
const toolCards = new Map();
api.chat.onToolStart(({ id, name, args }) => {
  if (!curAssistant) return;
  const card = el('div', 'tool-card');
  const head = el('div', 'tool-head');
  head.innerHTML = `<span class="spin">◌</span> ${escapeHtml(name)}`;
  card.appendChild(head);
  const argPre = el('pre', '', JSON.stringify(args, null, 2).slice(0, 800));
  card.appendChild(argPre);
  curAssistant.bubble.insertBefore(card, curAssistant.contentEl);
  toolCards.set(id, card);
  scrollBottom();
});
api.chat.onToolEnd(({ id, name, result }) => {
  const card = toolCards.get(id);
  if (!card) return;
  card.querySelector('.tool-head').innerHTML = `✔ ${escapeHtml(name)}`;
  const res = el('pre', '', result || '(no output)');
  card.appendChild(res);
  scrollBottom();
});
api.chat.onTimings(({ tokps, promptTokps, tokensIn, tokensOut, exact }) => {
  if (curAssistant) curAssistant.stats = { tokps, promptTokps, tokensIn, tokensOut, exact };
});
api.chat.onDone(({ content, seconds, tokens, tokensIn, tokensOut, exact, aborted }) => {
  state.streaming = false;
  $('btn-send').classList.remove('hidden');
  $('btn-stop').classList.add('hidden');
  if (curAssistant) {
    curAssistant.contentEl.innerHTML = renderMarkdown(curAssistant.raw || content || (aborted ? '(stopped)' : ''));
    // per-response footer: rate, then the two totals for this turn
    const st = curAssistant.stats || {};
    const outTok = st.tokensOut || tokensOut || tokens || 0;
    const inTok = st.tokensIn || tokensIn || 0;
    const approx = (st.exact ?? exact) ? '' : '~';
    const rate = st.tokps || (outTok && seconds ? outTok / seconds : 0);
    const bits = [];
    if (rate) bits.push(`${rate.toFixed(1)} tok/s`);
    if (st.promptTokps) bits.push(`prompt ${st.promptTokps} tok/s`);
    if (outTok) bits.push(`${approx}${fmtNum(outTok)} generated`);
    if (inTok) bits.push(`${fmtNum(inTok)} consumed`);
    if (seconds) bits.push(seconds + 's');
    curAssistant.meta.textContent = bits.join('  ·  ');
    if (content || curAssistant.raw) {
      state.history.push({ role: 'assistant', content: curAssistant.raw || content });
    }
    curAssistant = null;
  }
});
api.chat.onError(({ message }) => {
  state.streaming = false;
  $('btn-send').classList.remove('hidden');
  $('btn-stop').classList.add('hidden');
  if (curAssistant) {
    curAssistant.contentEl.innerHTML = renderMarkdown(curAssistant.raw);
    curAssistant = null;
  }
  toast(message, true);
});

async function sendMessage() {
  const input = $('input');
  const text = input.value.trim();
  if (!text || state.streaming) return;
  const online = state.target && state.target.kind === 'online';
  if (!online && !state.loadedModel) {
    toast('Load a local model, or pick an online model in the sidebar.', true);
    return;
  }
  input.value = '';
  autoGrow();
  state.history.push({ role: 'user', content: text });
  addUserMsg(text);
  startAssistantMsg();
  state.streaming = true;
  $('btn-send').classList.add('hidden');
  $('btn-stop').classList.remove('hidden');
  await api.chat.send({ messages: state.history, mode: state.mode, target: state.target });
}

$('btn-send').onclick = sendMessage;
$('btn-stop').onclick = () => api.chat.stop();
const inputEl = $('input');
function autoGrow() {
  inputEl.style.height = 'auto';
  inputEl.style.height = Math.min(inputEl.scrollHeight, 180) + 'px';
}
inputEl.addEventListener('input', autoGrow);
inputEl.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendMessage(); }
});

// ---------------- mode switch ----------------
$('mode-switch').addEventListener('click', (e) => {
  const btn = e.target.closest('button[data-mode]');
  if (!btn) return;
  state.mode = btn.dataset.mode;
  document.querySelectorAll('#mode-switch button').forEach((b) => b.classList.toggle('active', b === btn));
  toast({ chat: 'Chat mode — plain conversation.',
    desktop: 'Desktop Agent — model can run PowerShell, use files & MCP tools.',
    coding: 'Coding Agent — model can read/edit code, run builds & tests.' }[state.mode]);
});

// ---------------- admin toggle ----------------
async function refreshAdmin() {
  const { elevated, adminMode } = await api.admin.status();
  $('admin-toggle').checked = adminMode && elevated;
  if (elevated) document.querySelector('.admin-label').textContent = 'Admin ✓';
}
$('admin-toggle').addEventListener('change', async (e) => {
  const enabled = e.target.checked;
  if (enabled) {
    const ok = confirm('Enable Admin Mode?\n\nLlamaDesk will relaunch with Administrator rights (Windows UAC prompt). Agent tools will then run elevated — they can modify system files and settings.');
    if (!ok) { e.target.checked = false; return; }
  }
  const r = await api.admin.setMode(enabled);
  if (r.relaunching) toast('Relaunching elevated — accept the UAC prompt…');
  else refreshAdmin();
});

// ---------------- settings modal ----------------
const modal = $('modal');
$('btn-settings').onclick = () => { openSettings(); };
$('modal-close').onclick = () => modal.classList.add('hidden');
modal.addEventListener('click', (e) => { if (e.target === modal) modal.classList.add('hidden'); });
$('settings-tabs').addEventListener('click', (e) => {
  const btn = e.target.closest('button[data-tab]');
  if (!btn) return;
  document.querySelectorAll('#settings-tabs button').forEach((b) => b.classList.toggle('active', b === btn));
  document.querySelectorAll('.tab-page').forEach((p) => p.classList.add('hidden'));
  $('tab-' + btn.dataset.tab).classList.remove('hidden');
});
document.body.addEventListener('click', (e) => {
  const link = e.target.closest('.link[data-url]');
  if (link) api.openExternal(link.dataset.url);
});

async function openSettings() {
  state.settings = await api.settings.get();
  renderDirs();
  $('set-ctx').value = state.settings.ctxSize;
  $('set-ngl').value = state.settings.gpuLayers;
  $('set-port').value = state.settings.port;
  $('set-temp').value = state.settings.temperature;
  $('set-vram').value = state.settings.vramGB;
  $('set-extra').value = state.settings.extraArgs;
  $('set-backend').value = state.settings.backend;
  modal.classList.remove('hidden');
  renderMcp();
  renderSkills();
  renderProviders();
  refreshLlamaVersion();
}

function renderDirs() {
  const box = $('dir-list');
  box.innerHTML = '';
  for (const d of state.settings.modelDirs) {
    const row = el('div', 'dir-row');
    row.appendChild(el('span', '', d));
    const rm = el('button', 'icon-btn', '✕');
    rm.onclick = async () => {
      state.settings = await api.settings.set({ modelDirs: state.settings.modelDirs.filter((x) => x !== d) });
      renderDirs();
      rescanModels();
    };
    row.appendChild(rm);
    box.appendChild(row);
  }
}
async function addDir() {
  const dir = await api.pickFolder();
  if (!dir) return;
  state.settings = await api.settings.get();
  if (!state.settings.modelDirs.includes(dir)) {
    state.settings = await api.settings.set({ modelDirs: [...state.settings.modelDirs, dir] });
  }
  renderDirs();
  rescanModels();
  toast('Folder added — scanning for GGUF models…');
}
$('btn-add-dir').onclick = addDir;
$('btn-add-dir2').onclick = addDir;
$('btn-rescan').onclick = () => { rescanModels(); toast('Rescanned model folders.'); };

$('btn-save-general').onclick = async () => {
  state.settings = await api.settings.set({
    ctxSize: +$('set-ctx').value || 8192,
    gpuLayers: +$('set-ngl').value || 999,
    port: +$('set-port').value || 8033,
    temperature: +$('set-temp').value || 0.7,
    vramGB: +$('set-vram').value || 16,
    extraArgs: $('set-extra').value.trim(),
  });
  $('general-saved').textContent = 'Saved ✓ (takes effect on next model load)';
  setTimeout(() => ($('general-saved').textContent = ''), 3000);
  rescanModels();
};
$('set-backend').addEventListener('change', async () => {
  await api.settings.set({ backend: $('set-backend').value });
  checkUpdate();
});

// ---------------- llama.cpp update ----------------
async function refreshLlamaVersion() {
  const st = await api.llama.status();
  $('llama-version').textContent = st.installed
    ? `llama.cpp ${st.installed.tag} (${st.installed.backend})`
    : 'llama.cpp: not installed';
}
async function checkUpdate() {
  $('update-info').textContent = 'Checking latest release…';
  try {
    const info = await api.llama.checkUpdate();
    if (info.updateAvailable) {
      $('update-info').innerHTML = `Installed: <b>${info.installedTag || 'none'}</b> → Latest: <b>${info.latestTag}</b>` +
        (info.asset ? ` (${(info.asset.size / 1024 / 1024).toFixed(0)} MB)` : ' — no asset for this backend');
      if (info.asset) $('btn-do-update').classList.remove('hidden');
    } else {
      $('update-info').innerHTML = `Up to date: <b>${info.installedTag}</b>`;
      $('btn-do-update').classList.add('hidden');
    }
  } catch (err) {
    $('update-info').textContent = 'Update check failed: ' + String(err.message || err);
  }
}
$('btn-check-update').onclick = checkUpdate;
$('btn-update-llama').onclick = async () => {
  openSettings();
  document.querySelector('#settings-tabs button[data-tab="llama"]').click();
  checkUpdate();
};
$('btn-do-update').onclick = async () => {
  $('btn-do-update').disabled = true;
  $('update-progress').classList.remove('hidden');
  try {
    const r = await api.llama.update();
    toast('llama.cpp updated to ' + r.tag);
    refreshLlamaVersion();
    checkUpdate();
  } catch (err) {
    toast('Update failed: ' + String(err.message || err), true);
  } finally {
    $('btn-do-update').disabled = false;
    $('update-progress').classList.add('hidden');
  }
};
api.llama.onUpdateProgress((pct) => {
  const p = $('update-progress');
  p.querySelector('i').style.width = pct + '%';
  p.querySelector('span').textContent = pct + '%';
});

// ---------------- providers (v2) ----------------
async function renderProviders() {
  state.providers = await api.providers.list();
  const box = $('providers-list');
  box.innerHTML = '';
  for (const p of state.providers) {
    const card = el('div', 'provider-card');

    const top = el('div', 'provider-top');
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.checked = p.enabled;
    cb.title = 'Show this provider in the sidebar';
    cb.onchange = async () => {
      await api.providers.save({ name: p.name, patch: { enabled: cb.checked } });
      refreshProviders();
    };
    top.appendChild(cb);
    top.appendChild(el('span', 'name', p.label));
    top.appendChild(el('span', 'base', p.baseUrl));
    const keyState = el('span', 'key-state ' + (p.hasKey ? 'yes' : 'no'), p.hasKey ? '🔒 key saved' : 'no key');
    top.appendChild(keyState);
    if (!p.builtin) {
      const rm = el('button', 'icon-btn', '✕');
      rm.title = 'Remove custom provider';
      rm.onclick = async () => {
        await api.providers.save({ name: p.name, patch: null });
        await api.providers.setKey({ name: p.name, key: '' });
        renderProviders(); refreshProviders();
      };
      top.appendChild(rm);
    }
    card.appendChild(top);

    const keyRow = el('div', 'provider-key-row');
    const keyInput = document.createElement('input');
    keyInput.type = 'password';
    keyInput.placeholder = p.hasKey ? '•••••••• (saved — paste a new key to replace)' : 'Paste API key…';
    keyRow.appendChild(keyInput);
    const saveBtn = el('button', 'btn subtle small', 'Save key');
    saveBtn.onclick = async () => {
      const v = keyInput.value.trim();
      if (!v && !p.hasKey) return;
      await api.providers.setKey({ name: p.name, key: v });
      keyInput.value = '';
      toast(v ? p.label + ' key saved (encrypted).' : p.label + ' key removed.');
      renderProviders(); refreshProviders();
    };
    keyRow.appendChild(saveBtn);
    const testBtn = el('button', 'btn subtle small', 'Test');
    testBtn.onclick = async () => {
      testBtn.disabled = true;
      try {
        const r = await api.providers.test(p.name);
        toast(`${p.label}: connection OK (${r.models} models listed).`);
      } catch (err) {
        toast(`${p.label}: ` + String(err.message || err).replace(/^Error invoking remote method '[^']+': Error: /, ''), true);
      } finally { testBtn.disabled = false; }
    };
    keyRow.appendChild(testBtn);
    card.appendChild(keyRow);

    const modelsRow = el('div', 'provider-models');
    const modelsInput = document.createElement('input');
    modelsInput.value = p.models.join(', ');
    modelsInput.title = 'Comma-separated model ids shown in the sidebar';
    modelsInput.onchange = async () => {
      const models = modelsInput.value.split(',').map((s) => s.trim()).filter(Boolean);
      await api.providers.save({ name: p.name, patch: { models } });
      refreshProviders();
    };
    modelsRow.appendChild(modelsInput);
    const fetchBtn = el('button', 'btn subtle small', 'Fetch');
    fetchBtn.title = 'Fetch the model list from the provider API';
    fetchBtn.onclick = async () => {
      fetchBtn.disabled = true;
      try {
        const models = await api.providers.fetchModels(p.name);
        modelsInput.value = models.join(', ');
        toast(`${p.label}: ${models.length} models fetched.`);
        refreshProviders();
      } catch (err) { toast('Fetch failed: ' + String(err.message || err), true); }
      finally { fetchBtn.disabled = false; }
    };
    modelsRow.appendChild(fetchBtn);
    card.appendChild(modelsRow);

    box.appendChild(card);
  }
}
$('btn-provider-add').onclick = async () => {
  const name = prompt('Provider id (short, e.g. groq):');
  if (!name) return;
  const baseUrl = prompt('OpenAI-compatible base URL (e.g. https://api.groq.com/openai/v1):');
  if (!baseUrl) return;
  const models = prompt('Model ids (comma separated):') || '';
  await api.providers.save({
    name: name.toLowerCase().replace(/[^a-z0-9_-]/g, ''),
    patch: {
      label: name, baseUrl: baseUrl.trim(),
      models: models.split(',').map((s) => s.trim()).filter(Boolean),
      enabled: true,
    },
  });
  renderProviders(); refreshProviders();
};
$('btn-providers').onclick = () => {
  openSettings();
  document.querySelector('#settings-tabs button[data-tab="providers"]').click();
};

// ---------------- MCP ----------------
async function renderMcp() {
  const status = await api.mcp.status();
  state.settings = await api.settings.get();
  const box = $('mcp-list');
  box.innerHTML = '';
  const servers = state.settings.mcpServers || {};
  const statusMap = Object.fromEntries(status.map((s) => [s.name, s]));
  for (const [name, cfg] of Object.entries(servers)) {
    const st = statusMap[name] || {};
    const row = el('div', 'mcp-row');
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.checked = !!cfg.enabled;
    cb.onchange = async () => {
      servers[name].enabled = cb.checked;
      await api.mcp.save(servers);
    };
    row.appendChild(cb);
    const info = el('div', 'info');
    info.appendChild(el('div', 'name', name));
    info.appendChild(el('div', 'cmd', [cfg.command, ...(cfg.args || [])].join(' ')));
    row.appendChild(info);
    const stEl = el('span', 'st ' + (st.status || 'stopped'),
      st.status === 'ready' ? `● ready (${(st.tools || []).length} tools)` :
      st.status === 'error' ? '● error' : '● off');
    if (st.error) stEl.title = st.error;
    row.appendChild(stEl);
    const rm = el('button', 'icon-btn', '✕');
    rm.onclick = async () => {
      delete servers[name];
      await api.mcp.save(servers);
      renderMcp();
    };
    row.appendChild(rm);
    box.appendChild(row);
  }
  if (!Object.keys(servers).length) box.appendChild(el('div', 'muted', 'No MCP servers configured.'));
}
$('btn-mcp-import').onclick = async () => {
  try {
    await api.mcp.importClaude();
    toast('Imported servers from Claude Desktop config (disabled by default — enable & Apply).');
    renderMcp();
  } catch (err) { toast(String(err.message || err), true); }
};
$('btn-mcp-add').onclick = async () => {
  const name = prompt('Server name (e.g. pdf-tools):');
  if (!name) return;
  const cmd = prompt('Command line (e.g. npx -y @modelcontextprotocol/server-filesystem C:\\Users\\Office):');
  if (!cmd) return;
  const parts = cmd.match(/(?:[^\s"]+|"[^"]*")+/g).map((s) => s.replace(/^"|"$/g, ''));
  state.settings = await api.settings.get();
  const servers = state.settings.mcpServers || {};
  servers[name] = { command: parts[0], args: parts.slice(1), enabled: true };
  await api.mcp.save(servers);
  renderMcp();
};
$('btn-mcp-apply').onclick = async () => {
  toast('Connecting MCP servers…');
  const results = await api.mcp.apply();
  const ok = results.filter((r) => r.ok).length;
  const bad = results.filter((r) => !r.ok);
  toast(`MCP: ${ok} connected` + (bad.length ? `, ${bad.length} failed (${bad.map((b) => b.name).join(', ')})` : ''), bad.length > 0);
  renderMcp();
};

// ---------------- skills ----------------
async function renderSkills() {
  const skills = await api.skills.list();
  const box = $('skills-list');
  box.innerHTML = '';
  for (const s of skills) {
    const row = el('div', 'skill-row');
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.checked = s.enabled;
    cb.onchange = () => api.skills.toggle({ id: s.id, enabled: cb.checked });
    row.appendChild(cb);
    const info = el('div', 'info');
    info.appendChild(el('div', 'name', s.name));
    if (s.description) info.appendChild(el('div', 'desc', s.description));
    row.appendChild(info);
    const rm = el('button', 'icon-btn', '✕');
    rm.onclick = async () => { await api.skills.remove(s.id); renderSkills(); };
    row.appendChild(rm);
    box.appendChild(row);
  }
  if (!skills.length) box.appendChild(el('div', 'muted', 'No skills installed yet.'));
}
$('btn-skill-install').onclick = async () => {
  const src = $('skill-source').value.trim();
  if (!src) return;
  try {
    await api.skills.install(src);
    $('skill-source').value = '';
    toast('Skill installed.');
    renderSkills();
  } catch (err) { toast(String(err.message || err), true); }
};
$('btn-skill-folder').onclick = async () => {
  const dir = await api.pickFolder();
  if (dir) $('skill-source').value = dir;
};

// ---------------- init ----------------
(async function init() {
  state.settings = await api.settings.get();
  await rescanModels();
  refreshProviders();
  refreshAdmin();
  refreshLlamaVersion();
  const st = await api.llama.status();
  if (!st.installed) {
    toast('First run: install the llama.cpp runtime via Settings → llama.cpp → Download & install.');
  }
})();
