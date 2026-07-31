'use strict';
// OCR / vision via llama.cpp's multimodal CLI (llama-mtmd-cli + an mmproj projector).
// Pairs a vision GGUF with its mmproj-*.gguf sibling, which is how every llama.cpp
// vision model ships.
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const llama = require('./llama');

// Prompt presets. deepseek-ocr models (DeepSeek-OCR, Baidu Unlimited-OCR) want the
// short task phrasing; generic VL models answer a plain instruction.
const PROMPTS = {
  document: 'document parsing.',
  multipage: 'Multi page parsing.',
  free: 'Free OCR.',
  describe: 'Describe this image in detail.',
};

// Find every <model>.gguf that has an mmproj-*.gguf beside it.
function findVisionPairs(dirs) {
  const pairs = [];
  const walk = (dir, depth) => {
    if (depth > 4) return;
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    const files = entries.filter((e) => e.isFile() && /\.gguf$/i.test(e.name)).map((e) => e.name);
    const projectors = files.filter((f) => /^mmproj/i.test(f));
    if (projectors.length) {
      for (const f of files) {
        if (/^mmproj/i.test(f)) continue;
        pairs.push({
          model: path.join(dir, f),
          mmproj: path.join(dir, projectors[0]),
          name: f.replace(/\.gguf$/i, ''),
          sizeBytes: (() => { try { return fs.statSync(path.join(dir, f)).size; } catch { return 0; } })(),
        });
      }
    }
    for (const e of entries) if (e.isDirectory()) walk(path.join(dir, e.name), depth + 1);
  };
  for (const d of dirs) walk(d, 0);
  return pairs;
}

// Strip the layout markup deepseek-ocr models emit: <|det|>text [x,y,x,y]<|/det|>
function stripDet(s) {
  let t = s.replace(/<\|det\|>\s*\w*\s*\[[\d,\s]*\]<\|\/det\|>/g, '');
  t = t.replace(/^\s*\w+\s*\[[\d,\s]*\]<\|\/det\|>/gm, '');
  t = t.replace(/<\|[^|>]*\|>/g, '');
  return t.split('\n').map((l) => l.trim()).join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

function isDeepseekOcr(modelPath) {
  return /ocr/i.test(path.basename(modelPath));
}

// Run OCR on one image. Returns { text, raw, seconds }.
function run(imagePath, opts = {}) {
  const exe = llama.mtmdExe();
  if (!exe) {
    throw new Error('llama-mtmd-cli not found — install/refresh llama.cpp in Settings → llama.cpp (build b10199 or newer).');
  }
  const model = opts.model;
  const mmproj = opts.mmproj;
  if (!model || !mmproj) throw new Error('No vision model selected — choose one in Settings → OCR.');
  for (const f of [model, mmproj, imagePath]) {
    if (!fs.existsSync(f)) throw new Error('File not found: ' + f);
  }

  const prompt = PROMPTS[opts.mode] || PROMPTS.document;
  const args = [
    '-m', model,
    '--mmproj', mmproj,
    '--image', imagePath,
    '-p', prompt,
    '--temp', '0',
    '--flash-attn', 'off',
    '--no-warmup',
    '-n', String(opts.maxTokens || 4096),
    '-c', String(opts.ctx || 16384),
    '-ngl', '99',
  ];
  if (isDeepseekOcr(model)) args.push('--chat-template', 'deepseek-ocr');
  // The Vulkan backend lacks several CLIP ops on some GPUs and falls back anyway;
  // on those machines CPU vision encoding is faster. Measured per machine, not assumed.
  if (opts.cpuVision) args.push('--no-mmproj-offload');

  return new Promise((resolve, reject) => {
    const t0 = Date.now();
    const child = spawn(exe, args, { windowsHide: true, cwd: path.dirname(exe) });
    let out = '', err = '';
    const timer = setTimeout(() => { try { child.kill(); } catch { /* dead */ } },
      opts.timeoutMs || 15 * 60 * 1000);
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (err += d));
    child.on('error', (e) => { clearTimeout(timer); reject(new Error('Failed to start llama-mtmd-cli: ' + e.message)); });
    child.on('exit', (code) => {
      clearTimeout(timer);
      const raw = out.trim();
      if (!raw) {
        const tail = err.trim().split('\n').slice(-6).join('\n');
        return reject(new Error(`OCR produced no output (exit ${code}).\n${tail}`));
      }
      resolve({
        text: opts.raw ? raw : stripDet(raw),
        raw,
        seconds: Math.round((Date.now() - t0) / 100) / 10,
      });
    });
  });
}

module.exports = { run, findVisionPairs, PROMPTS };
