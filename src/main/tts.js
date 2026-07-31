'use strict';
// Text to speech using the offline Windows voices. No model download, no network.
//
// TWO ENGINES, because Windows splits its voices across two registries:
//   sapi  — System.Speech / SAPI5. Only voices under HKLM\...\Speech\Voices.
//   winrt — Windows.Media.SpeechSynthesis (OneCore). Sees the modern voice set,
//           which is usually a SUPERSET: on a stock machine SAPI shows 2 en-US
//           voices while WinRT also exposes en-IN and others installed for Narrator.
// Voices are merged and de-duplicated by (name, locale); WinRT wins ties because it
// reports a proper BCP-47 locale and gender.
//
// Text is always passed through a temp FILE, never the command line — it can be
// arbitrarily long and must never be interpolated into a PowerShell string.
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { app } = require('electron');

let speaking = null;
let voiceCache = null;

function tmpDir() {
  const d = path.join(app.getPath('userData'), 'tts');
  fs.mkdirSync(d, { recursive: true });
  return d;
}

const psq = (s) => `'${String(s).replace(/'/g, "''")}'`;
const xmlEsc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;')
  .replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;');

// -10..10 → SSML prosody percentage (+10 ≈ double speed, −10 ≈ half)
const ratePct = (r) => {
  const n = Math.max(-10, Math.min(10, Math.round(r || 0)));
  return (n >= 0 ? '+' : '') + (n >= 0 ? n * 10 : n * 5) + '%';
};

// Shared WinRT async plumbing for PowerShell.
const WINRT_PRELUDE = `
$ErrorActionPreference='Stop'
Add-Type -AssemblyName System.Runtime.WindowsRuntime | Out-Null
[Windows.Media.SpeechSynthesis.SpeechSynthesizer, Windows.Media, ContentType=WindowsRuntime] | Out-Null
[Windows.Storage.Streams.DataReader, Windows.Storage.Streams, ContentType=WindowsRuntime] | Out-Null
$asTaskGeneric = ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object {
  $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and
  $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation\`1' })[0]
function Await($op, $type) {
  $t = $asTaskGeneric.MakeGenericMethod($type).Invoke($null, @($op))
  $t.Wait(-1) | Out-Null
  $t.Result
}`;

function ps(script, { timeoutMs = 120000 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script],
      { windowsHide: true });
    let out = '', err = '';
    const timer = setTimeout(() => { try { child.kill(); } catch { /* dead */ } }, timeoutMs);
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (err += d));
    child.on('error', (e) => { clearTimeout(timer); reject(e); });
    child.on('exit', (code) => {
      clearTimeout(timer);
      if (code === 0) resolve(out);
      else reject(new Error(err.trim().split('\n').slice(-4).join('\n') || `powershell exited ${code}`));
    });
  });
}

// ---------------------------------------------------------------- voices ------
function localeName(tag) {
  const [lang, region] = String(tag || '').split('-');
  const L = {
    en: 'English', hi: 'Hindi', bn: 'Bengali', ta: 'Tamil', te: 'Telugu', mr: 'Marathi',
    gu: 'Gujarati', kn: 'Kannada', ml: 'Malayalam', pa: 'Punjabi', ur: 'Urdu',
    fr: 'French', de: 'German', es: 'Spanish', it: 'Italian', pt: 'Portuguese',
    nl: 'Dutch', pl: 'Polish', ru: 'Russian', tr: 'Turkish', ar: 'Arabic', he: 'Hebrew',
    ja: 'Japanese', ko: 'Korean', zh: 'Chinese', th: 'Thai', vi: 'Vietnamese',
    sv: 'Swedish', da: 'Danish', nb: 'Norwegian', fi: 'Finnish', cs: 'Czech',
    el: 'Greek', hu: 'Hungarian', ro: 'Romanian', id: 'Indonesian', ms: 'Malay',
  }[lang] || (lang ? lang.toUpperCase() : 'Unknown');
  const R = {
    US: 'United States', GB: 'United Kingdom', IN: 'India', AU: 'Australia', CA: 'Canada',
    IE: 'Ireland', NZ: 'New Zealand', ZA: 'South Africa', SG: 'Singapore', HK: 'Hong Kong',
    BR: 'Brazil', MX: 'Mexico', ES: 'Spain', FR: 'France', DE: 'Germany', CN: 'China', TW: 'Taiwan',
  }[region] || region || '';
  return R ? `${L} (${R})` : L;
}

async function listWinrt() {
  const out = await ps(`${WINRT_PRELUDE}
[Windows.Media.SpeechSynthesis.SpeechSynthesizer]::AllVoices | ForEach-Object {
  [pscustomobject]@{ name = $_.DisplayName; locale = $_.Language; gender = $_.Gender.ToString(); id = $_.Id }
} | ConvertTo-Json -Compress`).catch(() => '');
  const txt = (out || '').trim();
  if (!txt) return [];
  let parsed;
  try { parsed = JSON.parse(txt); } catch { return []; }
  return (Array.isArray(parsed) ? parsed : [parsed]).map((v) => ({ ...v, engine: 'winrt' }));
}

async function listSapi() {
  const out = await ps(`
Add-Type -AssemblyName System.Speech
$s = New-Object System.Speech.Synthesis.SpeechSynthesizer
$s.GetInstalledVoices() | Where-Object { $_.Enabled } | ForEach-Object {
  $i = $_.VoiceInfo
  [pscustomobject]@{ name = $i.Name; locale = $i.Culture.Name; gender = $i.Gender.ToString() }
} | ConvertTo-Json -Compress
$s.Dispose()`).catch(() => '');
  const txt = (out || '').trim();
  if (!txt) return [];
  let parsed;
  try { parsed = JSON.parse(txt); } catch { return []; }
  return (Array.isArray(parsed) ? parsed : [parsed]).map((v) => ({ ...v, engine: 'sapi' }));
}

// Normalise "Microsoft Heera Desktop" and "Microsoft Heera" to the same person.
const personKey = (name, locale) =>
  `${String(name).replace(/^Microsoft\s+/i, '').replace(/\s+Desktop$/i, '').trim().toLowerCase()}|${String(locale).toLowerCase()}`;

async function voices({ refresh = false } = {}) {
  if (voiceCache && !refresh) return voiceCache;
  const [winrt, sapi] = await Promise.all([listWinrt(), listSapi()]);
  const merged = new Map();
  for (const v of [...winrt, ...sapi]) {          // WinRT first — it wins duplicates
    const key = personKey(v.name, v.locale);
    if (merged.has(key)) continue;
    merged.set(key, {
      id: `${v.engine}|${v.name}`,
      name: v.name,
      engine: v.engine,
      locale: v.locale || '',
      language: localeName(v.locale),
      gender: (v.gender || '').toLowerCase() === 'female' ? 'Female'
        : (v.gender || '').toLowerCase() === 'male' ? 'Male' : 'Neutral',
    });
  }
  voiceCache = [...merged.values()].sort((a, b) =>
    a.language.localeCompare(b.language) || a.name.localeCompare(b.name));
  return voiceCache;
}

async function resolveVoice(id) {
  const list = await voices();
  if (!list.length) throw new Error('No speech voices are installed on this PC.');
  if (!id) return list[0];
  // exact composite id
  let v = list.find((x) => x.id === id);
  // legacy settings stored a bare voice name
  if (!v) v = list.find((x) => x.name === id);
  if (!v) v = list.find((x) => personKey(x.name, x.locale).startsWith(personKey(String(id).replace(/^\w+\|/, ''), '').split('|')[0]));
  return v || list[0];
}

// --------------------------------------------------------------- synthesis ----
function writeTemp(text, ext = 'txt') {
  const f = path.join(tmpDir(), `tts-${process.pid}-${Date.now()}.${ext}`);
  fs.writeFileSync(f, text, 'utf8');
  return f;
}

function sapiScript(txtFile, voice, rate, wavFile) {
  return `
Add-Type -AssemblyName System.Speech
$text = [IO.File]::ReadAllText(${psq(txtFile)}, [Text.Encoding]::UTF8)
$s = New-Object System.Speech.Synthesis.SpeechSynthesizer
try { $s.SelectVoice(${psq(voice.name)}) } catch { }
$s.Rate = ${Math.max(-10, Math.min(10, Math.round(rate || 0)))}
${wavFile ? `$s.SetOutputToWaveFile(${psq(wavFile)})` : '$s.SetOutputToDefaultAudioDevice()'}
$s.Speak($text)
$s.Dispose()`;
}

// WinRT has no Rate property — speed comes from an SSML prosody wrapper.
function winrtScript(txtFile, voice, rate, wavFile) {
  return `${WINRT_PRELUDE}
$text = [IO.File]::ReadAllText(${psq(txtFile)}, [Text.Encoding]::UTF8)
$esc = [Security.SecurityElement]::Escape($text)
$ssml = "<speak version='1.0' xmlns='http://www.w3.org/2001/10/synthesis' xml:lang='${voice.locale || 'en-US'}'><prosody rate='${ratePct(rate)}'>$esc</prosody></speak>"
$synth = New-Object Windows.Media.SpeechSynthesis.SpeechSynthesizer
$v = [Windows.Media.SpeechSynthesis.SpeechSynthesizer]::AllVoices | Where-Object { $_.DisplayName -eq ${psq(voice.name)} } | Select-Object -First 1
if ($v) { $synth.Voice = $v }
$stream = Await ($synth.SynthesizeSsmlToStreamAsync($ssml)) ([Windows.Media.SpeechSynthesis.SpeechSynthesisStream])
$reader = New-Object Windows.Storage.Streams.DataReader($stream.GetInputStreamAt(0))
Await ($reader.LoadAsync([uint32]$stream.Size)) ([uint32]) | Out-Null
$bytes = New-Object byte[] ([int]$stream.Size)
$reader.ReadBytes($bytes)
$synth.Dispose()
${wavFile
    ? `[IO.File]::WriteAllBytes(${psq(wavFile)}, $bytes)`
    : `$tmp = [IO.Path]::GetTempFileName() + '.wav'
[IO.File]::WriteAllBytes($tmp, $bytes)
$player = New-Object System.Media.SoundPlayer $tmp
$player.PlaySync()
$player.Dispose()
Remove-Item $tmp -Force -ErrorAction SilentlyContinue`}`;
}

async function buildScript(text, opts, wavFile) {
  const voice = await resolveVoice(opts.voice);
  const txtFile = writeTemp(text);
  const script = voice.engine === 'winrt'
    ? winrtScript(txtFile, voice, opts.rate, wavFile)
    : sapiScript(txtFile, voice, opts.rate, wavFile);
  return { script, txtFile, voice };
}

async function speak(text, opts = {}) {
  await stop();
  if (!text || !text.trim()) throw new Error('Nothing to speak.');
  const { script, txtFile, voice } = await buildScript(text, opts, null);
  return new Promise((resolve, reject) => {
    const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script],
      { windowsHide: true });
    speaking = child;
    let err = '';
    child.stderr.on('data', (d) => (err += d));
    child.on('error', (e) => { speaking = null; fs.rmSync(txtFile, { force: true }); reject(e); });
    child.on('exit', (code) => {
      speaking = null;
      fs.rmSync(txtFile, { force: true });
      if (code === 0 || code === null) resolve({ stopped: code === null, voice: voice.name, engine: voice.engine });
      else reject(new Error(err.trim().split('\n').slice(-4).join('\n') || `TTS exited ${code}`));
    });
  });
}

async function save(text, outPath, opts = {}) {
  if (!text || !text.trim()) throw new Error('Nothing to speak.');
  const { script, txtFile, voice } = await buildScript(text, opts, outPath);
  try { await ps(script, { timeoutMs: 10 * 60 * 1000 }); }
  finally { fs.rmSync(txtFile, { force: true }); }
  let bytes = 0;
  try { bytes = fs.statSync(outPath).size; } catch { /* checked below */ }
  if (!bytes) throw new Error('TTS wrote no audio — try a different voice.');
  return { path: outPath, bytes, voice: voice.name, engine: voice.engine };
}

// ----------------------------------------------------------------- demo -------
// A short sample in the voice's own language, so a preview of an fr-FR or hi-IN
// voice actually demonstrates that language rather than reading English badly.
const SAMPLES = {
  en: 'Hello — this is a preview of my voice, reading a sentence at the current speed.',
  hi: 'नमस्ते, यह मेरी आवाज़ का एक नमूना है।',
  bn: 'নমস্কার, এটি আমার কণ্ঠস্বরের একটি নমুনা।',
  ta: 'வணக்கம், இது என் குரலின் மாதிரி.',
  te: 'నమస్కారం, ఇది నా స్వరం యొక్క నమూనా.',
  mr: 'नमस्कार, हा माझ्या आवाजाचा नमुना आहे.',
  gu: 'નમસ્તે, આ મારા અવાજનો નમૂનો છે.',
  kn: 'ನಮಸ್ಕಾರ, ಇದು ನನ್ನ ಧ್ವನಿಯ ಮಾದರಿ.',
  ml: 'നമസ്കാരം, ഇത് എന്റെ ശബ്ദത്തിന്റെ ഒരു സാമ്പിൾ ആണ്.',
  ur: 'السلام علیکم، یہ میری آواز کا نمونہ ہے۔',
  fr: 'Bonjour, ceci est un aperçu de ma voix.',
  de: 'Hallo, dies ist eine Hörprobe meiner Stimme.',
  es: 'Hola, esta es una muestra de mi voz.',
  it: 'Ciao, questa è un anteprima della mia voce.',
  pt: 'Olá, esta é uma amostra da minha voz.',
  nl: 'Hallo, dit is een voorbeeld van mijn stem.',
  ru: 'Здравствуйте, это образец моего голоса.',
  ar: 'مرحبا، هذه عينة من صوتي.',
  ja: 'こんにちは。これは私の声のサンプルです。',
  ko: '안녕하세요. 제 목소리 샘플입니다.',
  zh: '你好，这是我的声音示例。',
  tr: 'Merhaba, bu benim sesimin bir örneğidir.',
  pl: 'Dzień dobry, to jest próbka mojego głosu.',
  th: 'สวัสดีค่ะ นี่คือตัวอย่างเสียงของฉัน',
  vi: 'Xin chào, đây là mẫu giọng nói của tôi.',
  id: 'Halo, ini adalah contoh suara saya.',
};

function sampleFor(voice) {
  const lang = String(voice.locale || 'en').split('-')[0].toLowerCase();
  const base = SAMPLES[lang] || SAMPLES.en;
  return lang === 'en' ? `${base} I am ${voice.name.replace(/^Microsoft\s+/i, '')}, ${voice.language}.` : base;
}

async function preview(voiceId, rate = 0) {
  const voice = await resolveVoice(voiceId);
  return speak(sampleFor(voice), { voice: voice.id, rate });
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

module.exports = { voices, speak, save, preview, stop, isSpeaking, localeName, sampleFor };
