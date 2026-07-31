// End-to-end UI test: boots the REAL app (real IPC, real main process) and drives
// the renderer's DOM. Catches wiring faults a load-only smoke test cannot see.
// Run: npx electron scripts/test-ui.js
const { app, BrowserWindow } = require('electron');

let failed = 0;
const check = (label, cond, extra) => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}${extra !== undefined && extra !== '' ? '  → ' + extra : ''}`);
  if (!cond) failed++;
};

// Boot the app exactly as production does.
require('../src/main/main.js');

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

app.whenReady().then(async () => {
  await wait(600);
  const win = BrowserWindow.getAllWindows()[0];
  if (!win) { console.log('FAIL  no window created'); app.exit(1); return; }
  const js = (code) => win.webContents.executeJavaScript(code, true);

  try {
    await new Promise((res) => {
      if (!win.webContents.isLoading()) return res();
      win.webContents.once('did-finish-load', res);
    });
    await wait(2500); // let init() finish its async work

    const errors = [];
    win.webContents.on('console-message', (_e, level, msg) => { if (level >= 2) errors.push(msg); });

    // ---------- task tabs ----------
    console.log('-- task tab strip --');
    const tabs = await js(`[...document.querySelectorAll('#task-tabs button')].map(b => b.dataset.task)`);
    check('8 task tabs rendered', tabs.length === 8, tabs.join(','));
    check('tabs are the expected ids',
      ['code', 'extract', 'docs', 'terminal', 'prompt', 'tutor', 'tts', 'ocr'].every((i) => tabs.includes(i)));
    check('exactly one tab is active',
      (await js(`document.querySelectorAll('#task-tabs button.active').length`)) === 1);
    check('title bar names the task',
      /\S/.test(await js(`document.getElementById('task-title').textContent`)),
      await js(`document.getElementById('task-title').textContent.trim()`));

    // ---------- switching to TTS swaps the controls ----------
    console.log('\n-- switching tasks swaps the controls --');
    await js(`document.querySelector('#task-tabs button[data-task="tts"]').click()`);
    await wait(900);
    check('TTS tab became active',
      (await js(`document.querySelector('#task-tabs button.active').dataset.task`)) === 'tts');
    check('TTS bar shown', !(await js(`document.getElementById('tts-bar').classList.contains('hidden')`)));
    check('OCR bar still hidden', await js(`document.getElementById('ocr-bar').classList.contains('hidden')`));
    check('send button relabelled to Speak',
      (await js(`document.getElementById('btn-send').textContent`)).includes('Speak'));
    const voices = await js(`[...document.getElementById('tts-voice').options].map(o=>o.value)`);
    check('voice list populated from Windows SAPI', voices.length > 0 && voices[0].length > 0, voices.join(' | '));

    // ---------- switching to OCR ----------
    console.log('\n-- OCR task --');
    await js(`document.querySelector('#task-tabs button[data-task="ocr"]').click()`);
    await wait(900);
    check('OCR bar shown', !(await js(`document.getElementById('ocr-bar').classList.contains('hidden')`)));
    check('TTS bar hidden again', await js(`document.getElementById('tts-bar').classList.contains('hidden')`));
    check('composer hidden for OCR', await js(`document.querySelector('.composer').classList.contains('hidden')`));
    check('OCR mode selector has 4 modes',
      (await js(`document.getElementById('ocr-mode').options.length`)) === 4);

    // ---------- back to a chat task ----------
    console.log('\n-- back to a chat task --');
    await js(`document.querySelector('#task-tabs button[data-task="docs"]').click()`);
    await wait(900);
    check('composer visible again', !(await js(`document.querySelector('.composer').classList.contains('hidden')`)));
    check('both task bars hidden', await js(
      `document.getElementById('tts-bar').classList.contains('hidden') && document.getElementById('ocr-bar').classList.contains('hidden')`));
    check('placeholder describes the task',
      (await js(`document.getElementById('input').placeholder`)).includes('Document Vetting'),
      await js(`document.getElementById('input').placeholder`));

    // ---------- attachments ----------
    console.log('\n-- attachment tray --');
    check('tray starts hidden', await js(`document.getElementById('attach-tray').classList.contains('hidden')`));
    check('attach buttons exist',
      await js(`!!document.getElementById('btn-attach') && !!document.getElementById('btn-attach-url')`));
    // inject an ingested attachment through the renderer's own code path
    await js(`(() => { state.attachments.push({ name:'contract.pdf', path:'D:\\\\x\\\\contract.pdf',
      kind:'pdf', text:'hello world', chars:11, pages:8, needsOcr:false }); renderAttachments(); })()`);
    await wait(250);
    check('tray shows after adding', !(await js(`document.getElementById('attach-tray').classList.contains('hidden')`)));
    check('chip renders the filename',
      (await js(`document.querySelector('#attach-tray .chip-name').textContent`)) === 'contract.pdf');
    check('chip shows char count',
      (await js(`document.querySelector('#attach-tray .chip-meta').textContent`)).includes('11'));
    // a needs-OCR chip must offer the OCR button
    await js(`(() => { state.attachments.push({ name:'scan.png', path:'D:\\\\x\\\\scan.png',
      kind:'image', text:'', chars:0, needsOcr:true, note:'Image — run OCR' }); renderAttachments(); })()`);
    await wait(250);
    check('needs-OCR chip offers an OCR button',
      (await js(`document.querySelectorAll('#attach-tray .chip-ocr').length`)) === 1);
    check('two chips present', (await js(`document.querySelectorAll('#attach-tray .chip').length`)) === 2);
    // remove one
    await js(`document.querySelectorAll('#attach-tray .chip-x')[0].click()`);
    await wait(250);
    check('removing a chip works', (await js(`document.querySelectorAll('#attach-tray .chip').length`)) === 1);

    // ---------- settings modal ----------
    console.log('\n-- settings: OCR & Voice tab --');
    await js(`document.getElementById('btn-settings').click()`);
    await wait(1200);
    await js(`document.querySelector('#settings-tabs button[data-tab="voice"]').click()`);
    await wait(600);
    check('OCR & Voice tab opens', !(await js(`document.getElementById('tab-voice').classList.contains('hidden')`)));
    check('auto-pick checkbox present', await js(`!!document.getElementById('set-autopick')`));
    check('TTS voice select populated in settings',
      (await js(`document.getElementById('set-tts-voice').options.length`)) > 0);
    await js(`document.getElementById('modal-close').click()`);

    check('no renderer console errors during the run', errors.length === 0, errors.slice(0, 3).join(' | '));
  } catch (err) {
    check('unexpected exception', false, String((err && err.stack) || err));
  }

  console.log(failed ? `\n${failed} FAILED` : '\nall checks passed');
  app.exit(failed ? 1 : 0);
});
