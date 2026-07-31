// Regression tests for three config-layer bugs found in the v2 review:
//   A. providers.js merged settings.providers over the presets SHALLOWLY, so a partial
//      stored entry replaced a whole preset and dropped baseUrl/label/models.
//      resolve() then threw "Cannot read properties of undefined (reading 'replace')".
//   B. llama.js spread the result of extraArgs.match(), which is null for a
//      whitespace-only string -> TypeError, surfacing as "the model won't load".
//   C. settings.js cached forever, so a settings.json edited outside the app stayed
//      invisible until restart.
// Run with: npx electron scripts/test-config-robustness.js
const { app } = require('electron');
const path = require('path');
const fs = require('fs');

let failed = 0;
const check = (label, cond, extra) => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}${extra ? '  → ' + extra : ''}`);
  if (!cond) failed++;
};

app.whenReady().then(() => {
  const src = (m) => require(path.join(__dirname, '..', 'src', 'main', m));
  const providers = src('providers.js');
  const settings = src('settings.js');

  const userData = app.getPath('userData');
  const settingsFile = path.join(userData, 'settings.json');
  const keysFile = path.join(userData, 'keys.json');
  const sBackup = fs.existsSync(settingsFile) ? fs.readFileSync(settingsFile) : null;
  const kBackup = fs.existsSync(keysFile) ? fs.readFileSync(keysFile) : null;

  try {
    // ---------- A. partial provider entry must inherit preset fields ----------
    console.log('\n-- A. partial provider entry (the shallow-merge bug) --');
    const partial = { providers: { deepseek: { enabled: true } } };

    const ds = providers.list(partial).find((p) => p.name === 'deepseek');
    check('partial entry keeps preset baseUrl', ds.baseUrl === 'https://api.deepseek.com/v1', String(ds.baseUrl));
    check('partial entry keeps preset label', ds.label === 'DeepSeek', ds.label);
    check('partial entry keeps preset models', ds.models.length === 2, JSON.stringify(ds.models));
    check('partial entry keeps the stored override', ds.enabled === true);

    providers.setKey('deepseek', 'sk-regression-probe');
    let resolved = null, threw = null;
    try { resolved = providers.resolve(partial, 'deepseek'); } catch (e) { threw = e; }
    check('resolve() no longer throws on a partial entry', threw === null, threw && threw.message);
    check('resolve() returns the preset baseUrl', resolved && resolved.baseUrl === 'https://api.deepseek.com/v1');
    providers.setKey('deepseek', '');

    // a stored value must still beat the preset
    const override = { providers: { deepseek: { baseUrl: 'https://proxy.example/v1' } } };
    check('stored baseUrl overrides the preset',
      providers.list(override).find((p) => p.name === 'deepseek').baseUrl === 'https://proxy.example/v1');

    // custom provider with no baseUrl -> actionable error, not a TypeError
    providers.setKey('nobase', 'sk-x');
    let e2 = null;
    try { providers.resolve({ providers: { nobase: { label: 'NoBase' } } }, 'nobase'); } catch (e) { e2 = e; }
    check('missing baseUrl gives an actionable error', !!e2 && /has no base URL/.test(e2.message), e2 && e2.message);
    check('  ...and is not a TypeError', !(e2 instanceof TypeError), e2 && e2.constructor.name);
    providers.setKey('nobase', '');

    // unknown provider still rejected
    let e3 = null;
    try { providers.resolve({ providers: {} }, 'ghost'); } catch (e) { e3 = e; }
    check('unknown provider still rejected', !!e3 && /Unknown provider/.test(e3.message));

    // ---------- B. extraArgs tokenising ----------
    console.log('\n-- B. extraArgs whitespace-only (the null-spread bug) --');
    // mirrors the expression in llama.js LlamaServer.start()
    const splitExtra = (extraArgs) =>
      ((extraArgs || '').match(/(?:[^\s"]+|"[^"]*")+/g) || []).map((s) => s.replace(/^"|"$/g, ''));

    for (const [label, input, expected] of [
      ['whitespace-only', '   ', []],
      ['empty string', '', []],
      ['undefined', undefined, []],
      ['tabs/newline', '\t \n ', []],
      ['normal flags', '--flash-attn on', ['--flash-attn', 'on']],
      ['quoted path', '--lora "C:\\my models\\a.gguf"', ['--lora', 'C:\\my models\\a.gguf']],
    ]) {
      let got, err = null;
      try { got = splitExtra(input); } catch (e) { err = e; }
      check(`extraArgs ${label}`, !err && JSON.stringify(got) === JSON.stringify(expected),
        err ? err.message : JSON.stringify(got));
    }

    // ---------- C. settings cache invalidation ----------
    console.log('\n-- C. settings.json edited outside the app --');
    settings.save({ temperature: 0.11 });
    check('save() then load() round-trips', settings.load().temperature === 0.11);

    const onDisk = JSON.parse(fs.readFileSync(settingsFile, 'utf8'));
    onDisk.temperature = 0.99;
    // bump mtime deterministically rather than relying on clock resolution
    fs.writeFileSync(settingsFile, JSON.stringify(onDisk, null, 2));
    const future = new Date(Date.now() + 5000);
    fs.utimesSync(settingsFile, future, future);

    check('external edit is picked up without restart', settings.load().temperature === 0.99,
      String(settings.load().temperature));
    check('unrelated keys survive the reload', settings.load().port === 8033, String(settings.load().port));
  } catch (err) {
    check('unexpected exception', false, String((err && err.stack) || err));
  } finally {
    if (sBackup) fs.writeFileSync(settingsFile, sBackup); else if (fs.existsSync(settingsFile)) fs.unlinkSync(settingsFile);
    if (kBackup) fs.writeFileSync(keysFile, kBackup); else if (fs.existsSync(keysFile)) fs.unlinkSync(keysFile);
  }

  console.log(failed ? `\n${failed} FAILED` : '\nall checks passed');
  app.exit(failed ? 1 : 0);
});
