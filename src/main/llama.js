'use strict';
// llama.cpp lifecycle: download/update prebuilt Windows binaries from GitHub
// releases (Vulkan build is the right choice for the RX 9070 XT), and manage
// the llama-server process for the selected model.
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { app } = require('electron');
const { pipeline } = require('stream/promises');
const { Readable } = require('stream');

const RELEASES_API = 'https://api.github.com/repos/ggml-org/llama.cpp/releases/latest';
const UA = { 'User-Agent': 'LlamaDesk/1.0', Accept: 'application/vnd.github+json' };

function baseDir() { return path.join(app.getPath('userData'), 'llama-cpp'); }
function versionFile() { return path.join(baseDir(), 'version.json'); }

function installedVersion() {
  try { return JSON.parse(fs.readFileSync(versionFile(), 'utf8')); } catch { return null; }
}

function findExe(dir, name) {
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return null; }
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isFile() && e.name.toLowerCase() === name) return p;
    if (e.isDirectory()) { const r = findExe(p, name); if (r) return r; }
  }
  return null;
}

function serverExe() {
  const v = installedVersion();
  if (!v) return null;
  return findExe(path.join(baseDir(), v.tag), 'llama-server.exe');
}

async function checkUpdate(backend) {
  const res = await fetch(RELEASES_API, { headers: UA });
  if (!res.ok) throw new Error(`GitHub API ${res.status}`);
  const rel = await res.json();
  const flavor = backend === 'cpu' ? 'cpu-x64' : `${backend}-x64`;
  const asset = (rel.assets || []).find(
    (a) => a.name.includes('bin-win') && a.name.includes(flavor) && a.name.endsWith('.zip')
  );
  const cur = installedVersion();
  return {
    latestTag: rel.tag_name,
    installedTag: cur ? cur.tag : null,
    updateAvailable: !cur || cur.tag !== rel.tag_name,
    asset: asset ? { name: asset.name, url: asset.browser_download_url, size: asset.size } : null,
    notes: rel.name || rel.tag_name,
  };
}

async function downloadUpdate(backend, onProgress) {
  const info = await checkUpdate(backend);
  if (!info.asset) throw new Error(`No win-${backend} asset in latest release — try another backend in Settings.`);
  const destDir = path.join(baseDir(), info.latestTag);
  const zipPath = path.join(baseDir(), info.asset.name);
  fs.mkdirSync(baseDir(), { recursive: true });

  const res = await fetch(info.asset.url, { headers: { 'User-Agent': UA['User-Agent'] } });
  if (!res.ok) throw new Error(`Download failed: HTTP ${res.status}`);
  const total = Number(res.headers.get('content-length')) || info.asset.size || 0;
  let got = 0;
  const counter = new (require('stream').Transform)({
    transform(chunk, enc, cb) {
      got += chunk.length;
      if (onProgress && total) onProgress(Math.round((got / total) * 100));
      cb(null, chunk);
    },
  });
  await pipeline(Readable.fromWeb(res.body), counter, fs.createWriteStream(zipPath));

  fs.rmSync(destDir, { recursive: true, force: true });
  await new Promise((resolve, reject) => {
    const ps = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
      `Expand-Archive -LiteralPath '${zipPath.replace(/'/g, "''")}' -DestinationPath '${destDir.replace(/'/g, "''")}' -Force`],
      { windowsHide: true });
    ps.on('exit', (code) => (code === 0 ? resolve() : reject(new Error('Extract failed (code ' + code + ')'))));
    ps.on('error', reject);
  });
  fs.rmSync(zipPath, { force: true });

  // prune older versions
  const old = installedVersion();
  if (old && old.tag !== info.latestTag) {
    fs.rmSync(path.join(baseDir(), old.tag), { recursive: true, force: true });
  }
  fs.writeFileSync(versionFile(), JSON.stringify({ tag: info.latestTag, backend, installedAt: new Date().toISOString() }));
  return { tag: info.latestTag };
}

// ---- server process ----
class LlamaServer {
  constructor() {
    this.proc = null;
    this.state = { running: false, starting: false, model: null, port: null, error: null, log: [] };
    this.listeners = new Set();
  }
  onState(fn) { this.listeners.add(fn); return () => this.listeners.delete(fn); }
  emit() { for (const fn of this.listeners) fn(this.getState()); }
  getState() { return { ...this.state, log: this.state.log.slice(-40) }; }
  pushLog(line) {
    this.state.log.push(line);
    if (this.state.log.length > 200) this.state.log.splice(0, this.state.log.length - 200);
  }

  async start(modelPath, settings) {
    await this.stop();
    const exe = serverExe();
    if (!exe) throw new Error('llama.cpp is not installed yet — use "Update llama.cpp" in Settings first.');
    const args = [
      '-m', modelPath,
      '--host', '127.0.0.1',
      '--port', String(settings.port),
      '-c', String(settings.ctxSize),
      '-ngl', String(settings.gpuLayers),
      '--jinja',
    ];
    // .match() returns null for a string with no tokens (e.g. "   "), so default
    // to [] — spreading null throws and would surface as an unloadable model.
    const extra = (settings.extraArgs || '').match(/(?:[^\s"]+|"[^"]*")+/g) || [];
    args.push(...extra.map((s) => s.replace(/^"|"$/g, '')));
    this.state = { ...this.state, starting: true, running: false, error: null, model: modelPath, port: settings.port, log: [] };
    this.emit();

    const proc = spawn(exe, args, { windowsHide: true, cwd: path.dirname(exe) });
    this.proc = proc;
    const onData = (d) => {
      for (const line of d.toString().split(/\r?\n/)) {
        if (line.trim()) this.pushLog(line.trim());
      }
      this.emit();
    };
    proc.stdout.on('data', onData);
    proc.stderr.on('data', onData);
    proc.on('exit', (code) => {
      if (this.proc === proc) {
        const wasStarting = this.state.starting;
        this.state.running = false;
        this.state.starting = false;
        if (code !== 0 && code !== null) {
          this.state.error = `llama-server exited with code ${code}` + (wasStarting ? ' during startup — check the server log.' : '');
        }
        this.proc = null;
        this.emit();
      }
    });
    proc.on('error', (err) => {
      this.state.error = String(err.message || err);
      this.state.starting = false;
      this.emit();
    });

    // wait for HTTP readiness
    const deadline = Date.now() + 180000;
    while (Date.now() < deadline) {
      if (!this.proc) throw new Error(this.state.error || 'Server crashed during startup');
      try {
        const r = await fetch(`http://127.0.0.1:${settings.port}/health`, { signal: AbortSignal.timeout(1500) });
        if (r.ok) {
          this.state.running = true;
          this.state.starting = false;
          this.emit();
          return this.getState();
        }
      } catch { /* not ready yet */ }
      await new Promise((r) => setTimeout(r, 700));
    }
    await this.stop();
    throw new Error('Timed out waiting for llama-server to become ready (3 min).');
  }

  async stop() {
    if (!this.proc) return;
    const p = this.proc;
    this.proc = null;
    try { p.kill(); } catch { /* already dead */ }
    await new Promise((r) => setTimeout(r, 200));
    try { spawn('taskkill', ['/pid', String(p.pid), '/f', '/t'], { windowsHide: true }); } catch { /* best effort */ }
    this.state.running = false;
    this.state.starting = false;
    this.state.model = null;
    this.emit();
  }
}

module.exports = { server: new LlamaServer(), checkUpdate, downloadUpdate, installedVersion, serverExe };
