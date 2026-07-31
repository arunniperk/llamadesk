'use strict';
const fs = require('fs');
const path = require('path');
const os = require('os');
const { app } = require('electron');

const DEFAULTS = {
  modelDirs: [path.join(os.homedir(), 'models')],
  port: 8033,
  ctxSize: 8192,
  gpuLayers: 999,
  backend: 'vulkan', // vulkan | hip | cpu — asset flavor of llama.cpp releases
  extraArgs: '',
  vramGB: 16,
  ramGB: Math.round(os.totalmem() / 1024 ** 3),
  adminMode: false,
  autoApproveTools: true,
  temperature: 0.7,
  skillsEnabled: [],
  // --- v2.1 workspace ---
  activeTask: 'code',      // tabbed workspace selection
  autoPickModel: true,     // let the app choose the best local model per task
  ocrModel: '',            // vision GGUF for the OCR task
  ocrMmproj: '',           // its mmproj-*.gguf projector
  ocrCpuVision: false,     // --no-mmproj-offload (faster on weak/iGPU setups)
  ocrMode: 'document',
  ttsVoice: '',            // empty = system default
  ttsRate: 0,              // SAPI -10..10
  providers: {}, // overrides/additions merged over providers.DEFAULT_PROVIDERS; keys live encrypted in keys.json
  mcpServers: {
    filesystem: {
      command: 'npx',
      args: ['-y', '@modelcontextprotocol/server-filesystem', os.homedir()],
      enabled: false,
    },
    'desktop-commander': {
      command: 'npx',
      args: ['-y', '@wonderwhy-er/desktop-commander'],
      enabled: false,
    },
  },
};

let cache = null;
let cacheMtime = -1;

function file() {
  return path.join(app.getPath('userData'), 'settings.json');
}

function mtimeOf(f) {
  try { return fs.statSync(f).mtimeMs; } catch { return 0; }
}

// The cache is keyed on the file's mtime, so a settings.json edited outside the
// app (or repaired by hand) is picked up on the next load instead of being
// masked until restart.
function load() {
  const f = file();
  const mtime = mtimeOf(f);
  if (cache && mtime === cacheMtime) return cache;
  try {
    cache = { ...DEFAULTS, ...JSON.parse(fs.readFileSync(f, 'utf8')) };
  } catch {
    cache = { ...DEFAULTS };
  }
  cacheMtime = mtime;
  return cache;
}

// NOTE: this is a shallow merge by design — nested objects (providers,
// mcpServers) are replaced wholesale so that entries can be *removed*. Callers
// patching one entry must therefore spread the existing map themselves.
function save(patch) {
  cache = { ...load(), ...patch };
  fs.mkdirSync(path.dirname(file()), { recursive: true });
  fs.writeFileSync(file(), JSON.stringify(cache, null, 2));
  cacheMtime = mtimeOf(file());
  return cache;
}

module.exports = { load, save, DEFAULTS };
