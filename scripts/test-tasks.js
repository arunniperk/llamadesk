// Task profiles + per-task model auto-selection.
// Ranks the user's REAL models (from settings.modelDirs, falling back to D:\Tor\Model)
// so the picker's judgement is visible, not just its plumbing.
// Run: npx electron scripts/test-tasks.js
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
  const tasks = src('tasks.js');
  const models = src('models.js');

  // ---------- profiles ----------
  console.log('-- task profiles --');
  const ui = tasks.listForUi();
  check('8 tasks exposed', ui.length === 8, String(ui.length));
  const ids = ui.map((t) => t.id);
  for (const want of ['code', 'extract', 'docs', 'terminal', 'prompt', 'tutor', 'tts', 'ocr']) {
    check(`  has "${want}"`, ids.includes(want));
  }
  check('every task has icon + blurb', ui.every((t) => t.icon && t.blurb));
  check('prompts are NOT shipped to the renderer', ui.every((t) => t.prompt === undefined));
  check('chat tasks carry a system prompt',
    tasks.TASKS.filter((t) => t.kind === 'chat').every((t) => t.prompt.length > 80));
  check('unknown id falls back, never throws', tasks.get('nope').id === 'code');
  check('tool policies are valid',
    tasks.TASKS.every((t) => ['full', 'readonly', 'none'].includes(t.tools)));
  check('extraction runs deterministic (temp 0)', tasks.get('extract').temperature === 0);
  check('prompt-gen runs hot', tasks.get('prompt').temperature >= 0.8);
  check('doc vetting demands the largest context',
    tasks.get('docs').minCtx >= 16384, String(tasks.get('docs').minCtx));

  // ---------- capability profiling ----------
  console.log('\n-- capability inference --');
  const fake = (file, ctx, gb) => {
    const m = { file, name: file.replace(/\.gguf$/, ''), path: 'X:\\' + file,
      contextLength: ctx, sizeBytes: gb * 1024 ** 3, quant: 'Q4_K_M', arch: '' };
    m.caps = models.capabilities(m);
    m.advice = { fit: gb <= 14 ? 'gpu' : 'hybrid', fitNote: '' };
    return m;
  };
  const coder = fake('Qwen2.5-Coder-14B-Instruct-abliterated-Q4_K_M.gguf', 32768, 8.4);
  const general = fake('huihui-ai_Qwen3-14B-abliterated-Q4_K_M.gguf', 40960, 8.4);
  const longdoc = fake('Huihui-Qwythos-9B-Claude-Mythos-5-1M-abliterated-Q6_K.gguf', 1000000, 7.6);
  const vision = fake('Unlimited-OCR-Q8_0.gguf', 32768, 2.9);
  const embed = fake('Qwen3-Embedding-4B-Q8_0.gguf', 8192, 4.0);

  check('coder scores high on coding', coder.caps.coding > general.caps.coding,
    `${coder.caps.coding} vs ${general.caps.coding}`);
  check('1M-context model wins on longctx', longdoc.caps.longctx === 10, String(longdoc.caps.longctx));
  check('OCR model flagged as vision', vision.caps.vision > 0, String(vision.caps.vision));
  check('abliterated flagged uncensored', general.caps.uncensored === 10);
  check('embedding model isolated', embed.caps.embedding === 10 && embed.caps.coding === 0);

  // Regression (v2.1.2): vision was decided two ways that could disagree — an
  // mmproj-*.gguf beside the model (proof, used by labelsFor) versus a filename regex
  // (guess, used by the OCR gate in pickFor). A projector-shipping model whose name has no
  // vision word was badged "Vision" in the sidebar yet refused by the OCR task.
  const projOnly = fake('Huihui-Qwythos-9B-Claude-Mythos-5-1M-abliterated-Q6_K.gguf', 1000000, 7.6);
  projOnly.mmproj = 'D:\\x\\mmproj-model-bf16.gguf';
  projOnly.vision = true;
  projOnly.caps = models.capabilities(projOnly);       // recompute now that vision is known
  check('mmproj beside a model proves vision even without a vision word in the name',
    projOnly.caps.vision > 0, String(projOnly.caps.vision));
  check('  ...so the OCR task will actually use it',
    !!models.pickFor([projOnly], tasks.get('ocr')).top);
  check('  ...and its label agrees with the picker',
    models.labelsFor(projOnly, {}).includes('Vision'));
  const noProj = fake('Some-Plain-Text-Model-7B-Q4_K_M.gguf', 32768, 4.2);
  check('a model with no projector and no vision word stays non-vision',
    noProj.caps.vision === 0 && !models.pickFor([noProj], tasks.get('ocr')).top);

  const pool = [coder, general, longdoc, vision, embed];
  check('coding task picks the coder',
    models.pickFor(pool, tasks.get('code')).top.model.file === coder.file,
    models.pickFor(pool, tasks.get('code')).top.model.file);
  check('doc vetting picks the 1M-context model',
    models.pickFor(pool, tasks.get('docs')).top.model.file === longdoc.file,
    models.pickFor(pool, tasks.get('docs')).top.model.file);
  check('OCR picks the vision model',
    models.pickFor(pool, tasks.get('ocr')).top.model.file === vision.file,
    models.pickFor(pool, tasks.get('ocr')).top.model.file);
  check('embedding model never wins a chat task',
    models.pickFor(pool, tasks.get('tutor')).ranked.every((r) => r.model.file !== embed.file));
  check('OCR rejects non-vision models entirely',
    models.pickFor(pool, tasks.get('ocr')).ranked.every((r) => r.model.caps.vision > 0));
  check('empty library returns no pick, no crash', models.pickFor([], tasks.get('code')).top === null);

  // a model too big for the machine is ranked below one that fits
  const huge = fake('Qwen3-Coder-Next-abliterated-Q4_K_M.gguf', 262144, 48.6);
  huge.advice = { fit: 'too-big', fitNote: '' };
  check('too-large model loses to one that fits',
    models.pickFor([coder, huge], tasks.get('code')).top.model.file === coder.file);

  // ---------- ranking over the REAL library ----------
  console.log('\n-- auto-pick over the real model library --');
  let dirs = [];
  try {
    const settings = src('settings.js');
    dirs = settings.load().modelDirs || [];
  } catch { /* defaults */ }
  if (!dirs.some((d) => fs.existsSync(d))) dirs = ['D:\\Tor\\Model'];
  const real = dirs.some((d) => fs.existsSync(d)) ? models.scan(dirs, 16, 64) : [];

  if (!real.length) {
    console.log('  (no local models found — skipping; plumbing already checked above)');
  } else {
    console.log(`  scanned ${real.length} model(s) from ${dirs.filter((d) => fs.existsSync(d)).join(', ')}\n`);
    for (const t of tasks.TASKS) {
      if (t.kind === 'tts') continue;
      const { top } = models.pickFor(real, t);
      const line = top
        ? `${top.model.name.slice(0, 46).padEnd(46)} score ${String(top.score).padStart(5)}  ${(top.reasons || []).join(', ')}`
        : '(none suitable)';
      console.log(`  ${(t.icon + ' ' + t.label).padEnd(26)} → ${line}`);
    }
    check('every non-TTS task resolves a model or an explicit null',
      tasks.TASKS.filter((t) => t.kind !== 'tts').every((t) => {
        const r = models.pickFor(real, t);
        return r.top === null || !!r.top.model.path;
      }));
  }

  console.log(failed ? `\n${failed} FAILED` : '\nall checks passed');
  app.exit(failed ? 1 : 0);
});
