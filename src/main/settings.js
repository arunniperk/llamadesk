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

function file() {
  return path.join(app.getPath('userData'), 'settings.json');
}

function load() {
  if (cache) return cache;
  try {
    cache = { ...DEFAULTS, ...JSON.parse(fs.readFileSync(file(), 'utf8')) };
  } catch {
    cache = { ...DEFAULTS };
  }
  return cache;
}

function save(patch) {
  cache = { ...load(), ...patch };
  fs.mkdirSync(path.dirname(file()), { recursive: true });
  fs.writeFileSync(file(), JSON.stringify(cache, null, 2));
  return cache;
}

module.exports = { load, save, DEFAULTS };
