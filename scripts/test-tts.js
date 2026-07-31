// TTS voice discovery, selection and demo rendering.
// Windows splits its voices across two engines: System.Speech (SAPI5) sees only the
// legacy set, while Windows.Media.SpeechSynthesis (OneCore) usually exposes more
// languages. This checks the merge, the locale/gender metadata and that a demo
// actually renders audible WAV audio.
// Run: npx electron scripts/test-tts.js
const { app } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');

let failed = 0;
const check = (label, cond, extra) => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}${extra !== undefined && extra !== '' ? '  → ' + extra : ''}`);
  if (!cond) failed++;
};

app.whenReady().then(async () => {
  const tts = require(path.join(__dirname, '..', 'src', 'main', 'tts.js'));

  console.log('-- voice discovery --');
  const voices = await tts.voices();
  check('at least one voice found', voices.length > 0, String(voices.length));
  if (!voices.length) { console.log('\nno voices — cannot continue'); app.exit(1); return; }

  console.log('\n  id                                    gender  locale  language');
  for (const v of voices) {
    console.log(`  ${v.id.padEnd(36)}  ${v.gender.padEnd(6)}  ${(v.locale || '').padEnd(6)}  ${v.language}`);
  }
  console.log('');

  check('every voice has a composite engine|name id', voices.every((v) => /^(sapi|winrt)\|/.test(v.id)));
  check('every voice reports a locale', voices.every((v) => /^[a-z]{2}(-[A-Z]{2})?$/.test(v.locale || '')),
    voices.map((v) => v.locale).join(','));
  check('every voice reports a gender', voices.every((v) => ['Male', 'Female', 'Neutral'].includes(v.gender)));
  check('every voice has a human-readable language', voices.every((v) => v.language && !/^[a-z]{2}-/.test(v.language)));
  check('no duplicate ids', new Set(voices.map((v) => v.id)).size === voices.length);
  check('the same person is not listed twice per locale',
    new Set(voices.map((v) => v.name.replace(/^Microsoft\s+/i, '').replace(/\s+Desktop$/i, '').toLowerCase() + v.locale)).size === voices.length,
    voices.map((v) => v.name).join(', '));

  // The whole point of the two-engine merge: OneCore usually adds languages SAPI lacks.
  const engines = new Set(voices.map((v) => v.engine));
  const locales = new Set(voices.map((v) => v.locale));
  console.log(`  engines: ${[...engines].join(', ')} | locales: ${[...locales].join(', ')}`);
  check('OneCore voices are reachable (the SAPI-only build could not see these)',
    engines.has('winrt'), [...engines].join(','));
  check('more than one locale is offered', locales.size > 1, [...locales].join(','));

  console.log('\n-- locale naming --');
  check('en-IN reads as English (India)', tts.localeName('en-IN') === 'English (India)', tts.localeName('en-IN'));
  check('en-US reads as English (United States)', tts.localeName('en-US') === 'English (United States)');
  check('hi-IN reads as Hindi (India)', tts.localeName('hi-IN') === 'Hindi (India)');
  check('unknown tag degrades gracefully', tts.localeName('xx-YY').length > 0, tts.localeName('xx-YY'));
  check('empty tag does not crash', typeof tts.localeName('') === 'string');

  console.log('\n-- demo sample text --');
  for (const v of voices) {
    const s = tts.sampleFor(v);
    check(`sample for ${v.name} (${v.locale}) is non-empty`, s.length > 10);
  }
  const hindi = tts.sampleFor({ locale: 'hi-IN', name: 'X', language: 'Hindi (India)' });
  check('a Hindi voice gets Devanagari sample text, not English', /[ऀ-ॿ]/.test(hindi), hindi);
  const french = tts.sampleFor({ locale: 'fr-FR', name: 'X', language: 'French (France)' });
  check('a French voice gets French sample text', /aperçu|voix/i.test(french), french);
  check('English sample names the voice',
    tts.sampleFor({ locale: 'en-IN', name: 'Microsoft Heera', language: 'English (India)' }).includes('Heera'));

  console.log('\n-- rendering audio (each engine) --');
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ld-tts-'));
  try {
    for (const engine of [...engines]) {
      const v = voices.find((x) => x.engine === engine);
      const out = path.join(outDir, `${engine}.wav`);
      let r = null, err = null;
      try { r = await tts.save(tts.sampleFor(v), out, { voice: v.id, rate: 0 }); }
      catch (e) { err = e; }
      check(`${engine}: save() produced a file via ${v.name}`, !!r && r.bytes > 2000,
        err ? err.message : `${r && r.bytes} bytes`);
      if (r) {
        const head = fs.readFileSync(out).subarray(0, 12);
        check(`${engine}: output is real RIFF/WAVE audio`,
          head.toString('ascii', 0, 4) === 'RIFF' && head.toString('ascii', 8, 12) === 'WAVE',
          head.toString('ascii', 0, 4) + '/' + head.toString('ascii', 8, 12));
      }
    }

    // rate must actually change the duration of the rendered audio
    const v0 = voices[0];
    const slow = path.join(outDir, 'slow.wav');
    const fast = path.join(outDir, 'fast.wav');
    const text = 'Testing the speaking rate control with a reasonably long sentence to measure.';
    const a = await tts.save(text, slow, { voice: v0.id, rate: -6 });
    const b = await tts.save(text, fast, { voice: v0.id, rate: 8 });
    check('a slower rate yields a longer file', a.bytes > b.bytes, `${a.bytes} vs ${b.bytes}`);
  } finally {
    fs.rmSync(outDir, { recursive: true, force: true });
  }

  console.log('\n-- resolution & guards --');
  const legacy = await tts.save.length; // touch to keep linters quiet
  void legacy;
  let e1 = null;
  try { await tts.speak('   ', { voice: voices[0].id }); } catch (e) { e1 = e; }
  check('empty text is rejected', !!e1 && /nothing to speak/i.test(e1.message), e1 && e1.message);
  check('isSpeaking() is false when idle', tts.isSpeaking() === false);
  check('stop() on an idle synth is harmless', (await tts.stop()) === false);

  console.log(failed ? `\n${failed} FAILED` : '\nall checks passed');
  app.exit(failed ? 1 : 0);
});
