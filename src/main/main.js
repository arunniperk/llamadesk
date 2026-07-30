'use strict';
const { app, BrowserWindow, ipcMain, dialog, shell } = require('electron');
const path = require('path');
const settings = require('./settings');
const models = require('./models');
const llama = require('./llama');
const monitor = require('./monitor');
const agent = require('./agent');
const mcp = require('./mcp');
const skillsMod = require('./skills');
const elevation = require('./elevation');
const providers = require('./providers');

let win = null;
const send = (ch, payload) => { if (win && !win.isDestroyed()) win.webContents.send(ch, payload); };

function createWindow() {
  win = new BrowserWindow({
    width: 1360,
    height: 860,
    minWidth: 980,
    minHeight: 640,
    backgroundColor: '#0b0d14',
    titleBarStyle: 'hidden',
    titleBarOverlay: { color: '#0b0d14', symbolColor: '#8b93a7', height: 40 },
    icon: path.join(__dirname, '..', '..', 'build', 'icon.png'),
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  win.setMenuBarVisibility(false);
  win.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
  win.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });
}

// ---------- IPC ----------
ipcMain.handle('settings:get', () => settings.load());
ipcMain.handle('settings:set', (_e, patch) => settings.save(patch));

ipcMain.handle('models:scan', () => {
  const s = settings.load();
  const list = models.scan(s.modelDirs, s.vramGB, s.ramGB);
  return { models: list, suggestions: models.suggest(list) };
});

ipcMain.handle('llama:start', async (_e, modelPath) => llama.server.start(modelPath, settings.load()));
ipcMain.handle('llama:stop', () => llama.server.stop());
ipcMain.handle('llama:status', () => ({
  ...llama.server.getState(),
  installed: llama.installedVersion(),
  exe: llama.serverExe(),
}));
ipcMain.handle('llama:checkUpdate', () => llama.checkUpdate(settings.load().backend));
ipcMain.handle('llama:update', async () => {
  const r = await llama.downloadUpdate(settings.load().backend, (pct) => send('llama:updateProgress', pct));
  return r;
});

ipcMain.handle('chat:send', (_e, { messages, mode, target }) => {
  const s = settings.load();
  agent.run({ messages, mode, settings: s, target }, (event, payload) => send('chat:' + event, payload))
    .catch((err) => send('chat:error', { message: String(err.message || err) }));
  return true;
});

// ---- online providers (v2) ----
ipcMain.handle('providers:list', () => providers.list(settings.load()));
ipcMain.handle('providers:save', (_e, { name, patch }) => {
  const s = settings.load();
  const merged = { ...providers.DEFAULT_PROVIDERS, ...(s.providers || {}) };
  const next = { ...(s.providers || {}) };
  if (patch === null) delete next[name];
  else next[name] = { ...(merged[name] || {}), ...patch };
  settings.save({ providers: next });
  return providers.list(settings.load());
});
ipcMain.handle('providers:setKey', (_e, { name, key }) => {
  providers.setKey(name, key);
  return providers.list(settings.load());
});
ipcMain.handle('providers:test', (_e, name) => providers.test(settings.load(), name));
ipcMain.handle('providers:fetchModels', async (_e, name) => {
  const models = await providers.fetchModels(settings.load(), name);
  const s = settings.load();
  const merged = { ...providers.DEFAULT_PROVIDERS, ...(s.providers || {}) };
  const next = { ...(s.providers || {}), [name]: { ...(merged[name] || {}), models } };
  settings.save({ providers: next });
  return models;
});
ipcMain.handle('chat:stop', () => agent.stop());

ipcMain.handle('mcp:status', () => mcp.manager.status());
ipcMain.handle('mcp:save', (_e, servers) => settings.save({ mcpServers: servers }));
ipcMain.handle('mcp:apply', async () => {
  const s = settings.load();
  return mcp.manager.startEnabled(s.mcpServers);
});
ipcMain.handle('mcp:importClaude', () => {
  const imported = mcp.importClaudeDesktopConfig();
  const s = settings.load();
  const merged = { ...imported, ...s.mcpServers };
  settings.save({ mcpServers: merged });
  return merged;
});

ipcMain.handle('skills:list', () => skillsMod.list(settings.load().skillsEnabled));
ipcMain.handle('skills:toggle', (_e, { id, enabled }) => {
  const s = settings.load();
  const set = new Set(s.skillsEnabled);
  if (enabled) set.add(id); else set.delete(id);
  settings.save({ skillsEnabled: [...set] });
  return skillsMod.list([...set]);
});
ipcMain.handle('skills:install', async (_e, source) => {
  await skillsMod.install(source);
  return skillsMod.list(settings.load().skillsEnabled);
});
ipcMain.handle('skills:remove', (_e, id) => {
  skillsMod.remove(id);
  const s = settings.load();
  settings.save({ skillsEnabled: s.skillsEnabled.filter((x) => x !== id) });
  return skillsMod.list(settings.load().skillsEnabled);
});

ipcMain.handle('admin:status', () => ({ elevated: elevation.isElevated(), adminMode: settings.load().adminMode }));
ipcMain.handle('admin:setMode', (_e, enabled) => {
  settings.save({ adminMode: enabled });
  const elevated = elevation.isElevated();
  if (enabled && !elevated) {
    elevation.relaunchElevated();
    return { relaunching: true, elevated };
  }
  return { relaunching: false, elevated };
});

ipcMain.handle('dialog:pickFolder', async () => {
  const r = await dialog.showOpenDialog(win, { properties: ['openDirectory'] });
  return r.canceled ? null : r.filePaths[0];
});
ipcMain.handle('shell:openExternal', (_e, url) => {
  if (/^https?:\/\//.test(url)) shell.openExternal(url);
});

// ---------- lifecycle ----------
app.whenReady().then(async () => {
  createWindow();
  monitor.start();
  monitor.onStats((stats) => send('monitor:stats', stats));
  llama.server.onState((state) => send('llama:state', state));
  // connect enabled MCP servers in the background
  mcp.manager.startEnabled(settings.load().mcpServers).catch(() => { /* reported via status */ });

  if (process.env.LLAMADESK_SMOKE) {
    win.webContents.on('console-message', (_e, level, message) => {
      if (level >= 2) console.log('SMOKE console:', message);
    });
    win.webContents.on('did-finish-load', () => {
      console.log('SMOKE: renderer loaded OK');
      setTimeout(() => app.quit(), 2500);
    });
  }
});

app.on('window-all-closed', () => app.quit());
app.on('before-quit', () => {
  monitor.stop();
  llama.server.stop();
  mcp.manager.stopAll();
});
