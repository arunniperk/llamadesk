'use strict';
// Online model providers (v2): OpenAI-compatible chat-completions APIs.
// DeepSeek / OpenAI / OpenRouter presets + user-defined custom providers.
// API keys are stored encrypted at rest with Electron safeStorage (Windows DPAPI)
// in userData/keys.json — never in settings.json, never logged.
const fs = require('fs');
const path = require('path');
const { app, safeStorage } = require('electron');

const DEFAULT_PROVIDERS = {
  deepseek: {
    label: 'DeepSeek',
    baseUrl: 'https://api.deepseek.com/v1',
    models: ['deepseek-chat', 'deepseek-reasoner'],
    enabled: false,
  },
  openai: {
    label: 'OpenAI',
    baseUrl: 'https://api.openai.com/v1',
    models: ['gpt-4o', 'gpt-4o-mini'],
    enabled: false,
  },
  openrouter: {
    label: 'OpenRouter',
    baseUrl: 'https://openrouter.ai/api/v1',
    models: ['deepseek/deepseek-chat', 'meta-llama/llama-3.3-70b-instruct'],
    enabled: false,
  },
};

function keysFile() { return path.join(app.getPath('userData'), 'keys.json'); }

function readKeys() {
  try { return JSON.parse(fs.readFileSync(keysFile(), 'utf8')); } catch { return {}; }
}
function writeKeys(obj) {
  fs.mkdirSync(path.dirname(keysFile()), { recursive: true });
  fs.writeFileSync(keysFile(), JSON.stringify(obj, null, 2));
}

function setKey(name, key) {
  const keys = readKeys();
  if (!key) {
    delete keys[name];
  } else if (safeStorage.isEncryptionAvailable()) {
    keys[name] = { enc: safeStorage.encryptString(key).toString('base64') };
  } else {
    keys[name] = { plain: Buffer.from(key, 'utf8').toString('base64') };
  }
  writeKeys(keys);
}

function getKey(name) {
  const k = readKeys()[name];
  if (!k) return null;
  try {
    if (k.enc) return safeStorage.decryptString(Buffer.from(k.enc, 'base64'));
    if (k.plain) return Buffer.from(k.plain, 'base64').toString('utf8');
  } catch { return null; }
  return null;
}

function hasKey(name) { return !!readKeys()[name]; }

// Merge stored settings.providers over the presets, ENTRY BY ENTRY.
// A shallow map-level spread would let a partial stored entry (e.g. `{enabled:true}`)
// replace a whole preset and silently drop its baseUrl/label/models, so every caller
// would have to re-spread the defaults by hand to stay safe.
function mergeProviders(settings) {
  const stored = settings.providers || {};
  const out = {};
  for (const name of new Set([...Object.keys(DEFAULT_PROVIDERS), ...Object.keys(stored)])) {
    out[name] = { ...(DEFAULT_PROVIDERS[name] || {}), ...(stored[name] || {}) };
  }
  return out;
}

// Merge stored settings.providers over defaults; annotate with key presence.
function list(settings) {
  const merged = mergeProviders(settings);
  return Object.entries(merged).map(([name, p]) => ({
    name,
    label: p.label || name,
    baseUrl: p.baseUrl,
    models: p.models || [],
    enabled: !!p.enabled,
    builtin: name in DEFAULT_PROVIDERS,
    hasKey: hasKey(name),
  }));
}

function resolve(settings, name) {
  const p = mergeProviders(settings)[name];
  if (!p) throw new Error(`Unknown provider "${name}"`);
  if (!p.baseUrl) {
    throw new Error(`Provider "${p.label || name}" has no base URL — set one in Settings → Providers.`);
  }
  const key = getKey(name);
  if (!key) throw new Error(`No API key saved for ${p.label || name} — add it in Settings → Providers.`);
  return { baseUrl: p.baseUrl.replace(/\/+$/, ''), key, label: p.label || name };
}

function authHeaders(name, key) {
  const h = { Authorization: `Bearer ${key}` };
  if (name === 'openrouter') {
    h['HTTP-Referer'] = 'https://llamadesk.local';
    h['X-Title'] = 'LlamaDesk';
  }
  return h;
}

async function test(settings, name) {
  const { baseUrl, key } = resolve(settings, name);
  const res = await fetch(baseUrl + '/models', {
    headers: authHeaders(name, key),
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`HTTP ${res.status}${res.status === 401 ? ' — invalid API key' : ''} ${body.slice(0, 200)}`);
  }
  const data = await res.json().catch(() => ({}));
  return { ok: true, models: (data.data || []).length };
}

async function fetchModels(settings, name) {
  const { baseUrl, key } = resolve(settings, name);
  const res = await fetch(baseUrl + '/models', {
    headers: authHeaders(name, key),
    signal: AbortSignal.timeout(20000),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const data = await res.json();
  let ids = (data.data || []).map((m) => m.id).filter(Boolean);
  ids.sort();
  if (ids.length > 40) ids = ids.slice(0, 40); // OpenRouter lists hundreds — cap for the sidebar
  return ids;
}

module.exports = { DEFAULT_PROVIDERS, mergeProviders, list, resolve, authHeaders, setKey, getKey, hasKey, test, fetchModels };
