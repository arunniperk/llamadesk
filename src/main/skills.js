'use strict';
// Skills: folders containing SKILL.md (Claude-style skills). Enabled skills are
// injected into the agent system prompt. Install from local folder, git URL, or zip.
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { app } = require('electron');

function skillsDir() {
  const d = path.join(app.getPath('userData'), 'skills');
  fs.mkdirSync(d, { recursive: true });
  return d;
}

function parseFrontmatter(md) {
  const m = md.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  const out = {};
  if (m) {
    for (const line of m[1].split(/\r?\n/)) {
      const kv = line.match(/^([A-Za-z_-]+):\s*(.*)$/);
      if (kv) out[kv[1].toLowerCase()] = kv[2].trim().replace(/^["']|["']$/g, '');
    }
  }
  return out;
}

function list(enabledNames) {
  const enabled = new Set(enabledNames || []);
  const out = [];
  for (const e of fs.readdirSync(skillsDir(), { withFileTypes: true })) {
    if (!e.isDirectory()) continue;
    const mdPath = path.join(skillsDir(), e.name, 'SKILL.md');
    if (!fs.existsSync(mdPath)) continue;
    let fm = {};
    try { fm = parseFrontmatter(fs.readFileSync(mdPath, 'utf8')); } catch { /* unreadable */ }
    out.push({
      id: e.name,
      name: fm.name || e.name,
      description: fm.description || '',
      enabled: enabled.has(e.name),
    });
  }
  return out;
}

function run(cmd, args, cwd) {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { cwd, windowsHide: true, shell: true });
    let err = '';
    p.stderr.on('data', (d) => (err += d));
    p.on('exit', (c) => (c === 0 ? resolve() : reject(new Error(err.slice(-500) || `${cmd} exited ${c}`))));
    p.on('error', reject);
  });
}

function copyDir(src, dest) {
  fs.mkdirSync(dest, { recursive: true });
  for (const e of fs.readdirSync(src, { withFileTypes: true })) {
    if (e.name === '.git' || e.name === 'node_modules') continue;
    const s = path.join(src, e.name), d = path.join(dest, e.name);
    if (e.isDirectory()) copyDir(s, d);
    else fs.copyFileSync(s, d);
  }
}

async function install(source) {
  const dir = skillsDir();
  if (/^https?:\/\/.+\.zip$/i.test(source)) {
    const tmpZip = path.join(dir, '_dl.zip');
    const res = await fetch(source);
    if (!res.ok) throw new Error('Download failed: HTTP ' + res.status);
    fs.writeFileSync(tmpZip, Buffer.from(await res.arrayBuffer()));
    const name = path.basename(source, '.zip').replace(/[^a-zA-Z0-9_-]/g, '-');
    const dest = path.join(dir, name);
    await run('powershell.exe', ['-NoProfile', '-Command',
      `Expand-Archive -LiteralPath '${tmpZip}' -DestinationPath '${dest}' -Force`]);
    fs.rmSync(tmpZip, { force: true });
    return normalize(dest, name);
  }
  if (/^(https?:\/\/|git@)/.test(source)) {
    const name = source.replace(/\.git$/, '').split('/').pop().replace(/[^a-zA-Z0-9_-]/g, '-');
    const dest = path.join(dir, name);
    fs.rmSync(dest, { recursive: true, force: true });
    await run('git', ['clone', '--depth', '1', source, `"${dest}"`]);
    return normalize(dest, name);
  }
  // local folder
  if (!fs.existsSync(source)) throw new Error('Path not found: ' + source);
  const name = path.basename(source).replace(/[^a-zA-Z0-9_-]/g, '-');
  const dest = path.join(dir, name);
  copyDir(source, dest);
  return normalize(dest, name);
}

// If SKILL.md is nested one level down (zip/repo wrapper dir), hoist it.
function normalize(dest, name) {
  if (!fs.existsSync(path.join(dest, 'SKILL.md'))) {
    const subs = fs.readdirSync(dest, { withFileTypes: true }).filter((e) => e.isDirectory());
    for (const s of subs) {
      if (fs.existsSync(path.join(dest, s.name, 'SKILL.md'))) {
        const tmp = dest + '_tmp';
        fs.renameSync(path.join(dest, s.name), tmp);
        fs.rmSync(dest, { recursive: true, force: true });
        fs.renameSync(tmp, dest);
        break;
      }
    }
  }
  if (!fs.existsSync(path.join(dest, 'SKILL.md'))) {
    throw new Error('No SKILL.md found in the installed skill.');
  }
  return { id: name };
}

function remove(id) {
  const target = path.join(skillsDir(), id);
  if (path.dirname(target) !== skillsDir()) throw new Error('Invalid skill id');
  fs.rmSync(target, { recursive: true, force: true });
}

function buildPrompt(enabledNames) {
  const parts = [];
  for (const id of enabledNames || []) {
    const mdPath = path.join(skillsDir(), id, 'SKILL.md');
    try {
      let content = fs.readFileSync(mdPath, 'utf8');
      if (content.length > 24000) content = content.slice(0, 24000) + '\n…(truncated)';
      parts.push(`## Skill: ${id}\n(base directory: ${path.join(skillsDir(), id)})\n\n${content}`);
    } catch { /* skill vanished */ }
  }
  return parts.length ? `\n\n# Installed skills\nFollow these skill instructions when relevant:\n\n${parts.join('\n\n---\n\n')}` : '';
}

module.exports = { list, install, remove, buildPrompt, skillsDir };
