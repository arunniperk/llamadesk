// Runtime check for providers.js: DPAPI key round-trip + resolve() wiring.
// Run with: npx electron scripts/test-providers.js
const { app, safeStorage } = require('electron');
const path = require('path');
const fs = require('fs');

app.whenReady().then(() => {
  const providers = require(path.join(__dirname, '..', 'src', 'main', 'providers.js'));
  const keysFile = path.join(app.getPath('userData'), 'keys.json');
  const backup = fs.existsSync(keysFile) ? fs.readFileSync(keysFile) : null;
  let failed = 0;
  const check = (label, cond, extra) => {
    console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}${extra ? '  → ' + extra : ''}`);
    if (!cond) failed++;
  };

  try {
    check('safeStorage encryption available', safeStorage.isEncryptionAvailable());

    const secret = 'sk-test-DEADBEEF-1234567890';
    providers.setKey('deepseek', secret);
    check('hasKey after setKey', providers.hasKey('deepseek'));
    check('getKey round-trips', providers.getKey('deepseek') === secret);

    const raw = fs.readFileSync(keysFile, 'utf8');
    check('key is NOT stored in plaintext on disk', !raw.includes(secret));
    check('key stored under enc field', JSON.parse(raw).deepseek.enc !== undefined);

    const settings = { providers: {} };
    const r = providers.resolve(settings, 'deepseek');
    check('resolve() base URL', r.baseUrl === 'https://api.deepseek.com/v1', r.baseUrl);
    check('resolve() returns key', r.key === secret);

    const h = providers.authHeaders('deepseek', secret);
    check('auth header', h.Authorization === 'Bearer ' + secret);
    const hor = providers.authHeaders('openrouter', secret);
    check('openrouter extra headers', hor['X-Title'] === 'LlamaDesk');

    const listed = providers.list(settings);
    const ds = listed.find((p) => p.name === 'deepseek');
    check('list() marks builtin + hasKey', ds.builtin === true && ds.hasKey === true);
    check('list() includes deepseek-reasoner', ds.models.includes('deepseek-reasoner'));

    // custom provider override merges over defaults
    const custom = { providers: { groq: { label: 'Groq', baseUrl: 'https://api.groq.com/openai/v1', models: ['llama-3.3-70b'], enabled: true } } };
    check('custom provider appears in list', providers.list(custom).some((p) => p.name === 'groq' && !p.builtin));

    providers.setKey('deepseek', '');
    check('setKey("") removes the key', !providers.hasKey('deepseek'));

    let threw = false;
    try { providers.resolve(settings, 'deepseek'); } catch { threw = true; }
    check('resolve() errors without a key', threw);

    let threw2 = false;
    try { providers.resolve(settings, 'nope'); } catch { threw2 = true; }
    check('resolve() errors on unknown provider', threw2);
  } finally {
    if (backup) fs.writeFileSync(keysFile, backup);
    else fs.rmSync(keysFile, { force: true });
    console.log(failed === 0 ? '\nALL PASS' : `\n${failed} FAILURE(S)`);
    app.exit(failed === 0 ? 0 : 1);
  }
});
