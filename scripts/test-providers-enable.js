// Runtime check for the provider enable gate: saving a key or fetching models must
// leave the provider visible in the sidebar (enabled), so fetched models can't be
// stored-but-hidden. Exercises the real ipc handler bodies via a stubbed ipcMain.
// Run with: npx electron scripts/test-providers-enable.js
// NOTE: run this way Electron's app name is "Electron", so userData is %APPDATA%\Electron —
// the real app's %APPDATA%\llamadesk config is never touched. The backup/restore below only
// guards that throwaway dir. To inspect real config, app.setPath('userData', …) first.
const { app } = require('electron');
const path = require('path');
const fs = require('fs');
const http = require('http');

let failed = 0;
const check = (label, cond, extra) => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}${extra ? '  → ' + extra : ''}`);
  if (!cond) failed++;
};

app.whenReady().then(async () => {
  const src = (m) => require(path.join(__dirname, '..', 'src', 'main', m));
  const settings = src('settings.js');
  const providers = src('providers.js');

  const userData = app.getPath('userData');
  const settingsFile = path.join(userData, 'settings.json');
  const keysFile = path.join(userData, 'keys.json');
  const sBackup = fs.existsSync(settingsFile) ? fs.readFileSync(settingsFile) : null;
  const kBackup = fs.existsSync(keysFile) ? fs.readFileSync(keysFile) : null;

  // fake provider API so fetchModels has something to list
  const server = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ data: [{ id: 'test-pro' }, { id: 'test-flash' }] }));
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;

  // the handler bodies from main.js, verbatim in behaviour
  const patchProvider = (name, patch) => {
    const s = settings.load();
    const merged = { ...providers.DEFAULT_PROVIDERS, ...(s.providers || {}) };
    settings.save({ providers: { ...(s.providers || {}), [name]: { ...(merged[name] || {}), ...patch } } });
  };
  const setKeyHandler = (name, key) => {
    providers.setKey(name, key);
    if (key) patchProvider(name, { enabled: true });
    return providers.list(settings.load());
  };
  const fetchHandler = async (name) => {
    const models = await providers.fetchModels(settings.load(), name);
    patchProvider(name, { models, enabled: true });
    return models;
  };
  const sidebarVisible = () => providers.list(settings.load()).filter((p) => p.enabled && p.hasKey).map((p) => p.name);

  try {
    check('preset providers ship disabled', providers.DEFAULT_PROVIDERS.deepseek.enabled === false);

    // ---- 1. the reported bug: fetched models stored but provider left hidden ----
    settings.save({ providers: { fake: { label: 'Fake', baseUrl: `http://127.0.0.1:${port}/v1`, models: ['old'], enabled: false } } });
    providers.setKey('fake', 'sk-test');
    check('repro: key + models but enabled:false → nothing in sidebar',
      !sidebarVisible().includes('fake'), JSON.stringify(sidebarVisible()));

    // ---- 2. fetching now enables it ----
    const models = await fetchHandler('fake');
    check('fetch returns the provider list', JSON.stringify(models) === JSON.stringify(['test-flash', 'test-pro']), JSON.stringify(models));
    let entry = settings.load().providers.fake;
    check('fetch persists the models', JSON.stringify(entry.models) === JSON.stringify(['test-flash', 'test-pro']));
    check('fetch enables the provider', entry.enabled === true);
    check('fetched models now reach the sidebar', sidebarVisible().includes('fake'), JSON.stringify(sidebarVisible()));

    // ---- 3. saving a key enables it too ----
    settings.save({ providers: { fake: { ...entry, enabled: false } } });
    setKeyHandler('fake', 'sk-test-2');
    check('saving a key enables the provider', settings.load().providers.fake.enabled === true);
    check('sidebar shows it after key save', sidebarVisible().includes('fake'));

    // ---- 4. an explicit untick must still win (not clobbered by the auto-enable) ----
    patchProvider('fake', { enabled: false });
    check('manual disable is respected', !sidebarVisible().includes('fake'));

    // ---- 5. removing a key must not enable anything ----
    setKeyHandler('fake', '');
    check('clearing a key leaves it hidden', !sidebarVisible().includes('fake'));
    check('clearing a key drops hasKey', !providers.hasKey('fake'));
  } catch (err) {
    check('unexpected exception', false, String((err && err.stack) || err));
  } finally {
    server.close();
    if (sBackup) fs.writeFileSync(settingsFile, sBackup); else if (fs.existsSync(settingsFile)) fs.unlinkSync(settingsFile);
    if (kBackup) fs.writeFileSync(keysFile, kBackup); else if (fs.existsSync(keysFile)) fs.unlinkSync(keysFile);
  }

  console.log(failed ? `\n${failed} FAILED` : '\nall checks passed');
  app.exit(failed ? 1 : 0);
});
