'use strict';
// Text to speech via the offline Windows voices (System.Speech / SAPI).
// No model download, no network. Text is passed through a temp FILE rather than
// the command line — it can be arbitrarily long and must never be interpolated
// into a PowerShell string.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { app } = require('electron');

let speaking = null; // in-flight child process

function tmpDir() {
  const d = path.join(app.getPath('userData'), 'tts');
  fs.mkdirSync(d, { recursive: true });
  return d;
}

function ps(script, { detach = false } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
      windowsHide: true,
    });
    let out = '', err = '';
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (err += d));
    child.on('error', reject);
    child.on('exit', (code) => (code === 0
      ? resolve(out)
      : reject(new Error(err.trim().split('\n').slice(-4).join('\n') || `powershell exited ${code}`))));
    if (detach) resolve({ child });
  });
}

async function voices() {
  const out = await ps(`
Add-Type -AssemblyName System.Speech
$s = New-Object System.Speech.Synthesis.SpeechSynthesizer
$s.GetInstalledVoices() | Where-Object { $_.Enabled } | ForEach-Object {
  $i = $_.VoiceInfo
  [pscustomobject]@{ name = $i.Name; culture = $i.Culture.Name; gender = $i.Gender.ToString() }
} | ConvertTo-Json -Compress
$s.Dispose()`);
  const txt = out.trim();
  if (!txt) return [];
  const parsed = JSON.parse(txt);
  return Array.isArray(parsed) ? parsed : [parsed];
}

// Build the synth script shared by speak/save. `rate` is SAPI's -10..10.
function synthScript(txtFile, { voice, rate = 0, volume = 100, wavFile = null }) {
  const q = (s) => `'${String(s).replace(/'/g, "''")}'`;
  return `
Add-Type -AssemblyName System.Speech
$text = [IO.File]::ReadAllText(${q(txtFile)}, [Text.Encoding]::UTF8)
$s = New-Object System.Speech.Synthesis.SpeechSynthesizer
${voice ? `try { $s.SelectVoice(${q(voice)}) } catch { }` : ''}
$s.Rate = ${Math.max(-10, Math.min(10, Math.round(rate)))}
$s.Volume = ${Math.max(0, Math.min(100, Math.round(volume)))}
${wavFile ? `$s.SetOutputToWaveFile(${q(wavFile)})` : '$s.SetOutputToDefaultAudioDevice()'}
$s.Speak($text)
$s.Dispose()`;
}

function writeTemp(text) {
  const f = path.join(tmpDir(), `speak-${process.pid}-${Math.floor(process.hrtime()[1] / 1000)}.txt`);
  fs.writeFileSync(f, text, 'utf8');
  return f;
}

// Speak aloud. Resolves when playback finishes (or is stopped).
async function speak(text, opts = {}) {
  await stop();
  if (!text || !text.trim()) throw new Error('Nothing to speak.');
  const txtFile = writeTemp(text);
  return new Promise((resolve, reject) => {
    const child = spawn('powershell.exe',
      ['-NoProfile', '-NonInteractive', '-Command', synthScript(txtFile, opts)], { windowsHide: true });
    speaking = child;
    let err = '';
    child.stderr.on('data', (d) => (err += d));
    child.on('error', (e) => { speaking = null; fs.rmSync(txtFile, { force: true }); reject(e); });
    child.on('exit', (code) => {
      speaking = null;
      fs.rmSync(txtFile, { force: true });
      if (code === 0 || code === null) resolve({ stopped: code === null });
      else reject(new Error(err.trim().split('\n').slice(-4).join('\n') || `TTS exited ${code}`));
    });
  });
}

// Render to a .wav file instead of the speakers.
async function save(text, outPath, opts = {}) {
  if (!text || !text.trim()) throw new Error('Nothing to speak.');
  const txtFile = writeTemp(text);
  try {
    await ps(synthScript(txtFile, { ...opts, wavFile: outPath }));
  } finally {
    fs.rmSync(txtFile, { force: true });
  }
  let bytes = 0;
  try { bytes = fs.statSync(outPath).size; } catch { /* reported below */ }
  if (!bytes) throw new Error('TTS wrote no audio — check the selected voice.');
  return { path: outPath, bytes };
}

async function stop() {
  if (!speaking) return false;
  const child = speaking;
  speaking = null;
  try { child.kill(); } catch { /* already gone */ }
  try { spawn('taskkill', ['/pid', String(child.pid), '/f', '/t'], { windowsHide: true }); } catch { /* best effort */ }
  return true;
}

function isSpeaking() { return !!speaking; }

module.exports = { voices, speak, save, stop, isSpeaking, defaultDir: () => os.homedir() };
