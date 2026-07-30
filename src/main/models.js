'use strict';
// Scans configured directories for .gguf files, parses GGUF metadata headers,
// and produces purpose recommendations for the user's hardware.
const fs = require('fs');
const path = require('path');

const GGUF_MAGIC = 0x46554747; // 'GGUF' little-endian

// ---- GGUF metadata parser (reads the first 2 MB, bails gracefully) ----
class Reader {
  constructor(buf) { this.buf = buf; this.off = 0; }
  need(n) { if (this.off + n > this.buf.length) throw new Error('eof'); }
  u8() { this.need(1); return this.buf.readUInt8(this.off++); }
  i8() { this.need(1); return this.buf.readInt8(this.off++); }
  u16() { this.need(2); const v = this.buf.readUInt16LE(this.off); this.off += 2; return v; }
  i16() { this.need(2); const v = this.buf.readInt16LE(this.off); this.off += 2; return v; }
  u32() { this.need(4); const v = this.buf.readUInt32LE(this.off); this.off += 4; return v; }
  i32() { this.need(4); const v = this.buf.readInt32LE(this.off); this.off += 4; return v; }
  f32() { this.need(4); const v = this.buf.readFloatLE(this.off); this.off += 4; return v; }
  u64() { this.need(8); const v = this.buf.readBigUInt64LE(this.off); this.off += 8; return Number(v); }
  i64() { this.need(8); const v = this.buf.readBigInt64LE(this.off); this.off += 8; return Number(v); }
  f64() { this.need(8); const v = this.buf.readDoubleLE(this.off); this.off += 8; return v; }
  str() { const n = this.u64(); this.need(n); const s = this.buf.toString('utf8', this.off, this.off + n); this.off += n; return s; }
  value(type) {
    switch (type) {
      case 0: return this.u8();
      case 1: return this.i8();
      case 2: return this.u16();
      case 3: return this.i16();
      case 4: return this.u32();
      case 5: return this.i32();
      case 6: return this.f32();
      case 7: return this.u8() !== 0;
      case 8: return this.str();
      case 9: {
        const t = this.u32();
        const n = this.u64();
        if (n > 4096) { // huge array (tokenizer vocab) — stop parsing here
          throw new Error('big-array');
        }
        const arr = [];
        for (let i = 0; i < n; i++) arr.push(this.value(t));
        return arr;
      }
      case 10: return this.u64();
      case 11: return this.i64();
      case 12: return this.f64();
      default: throw new Error('unknown type ' + type);
    }
  }
}

function parseGguf(filePath) {
  const fd = fs.openSync(filePath, 'r');
  try {
    const buf = Buffer.alloc(2 * 1024 * 1024);
    const read = fs.readSync(fd, buf, 0, buf.length, 0);
    const r = new Reader(buf.subarray(0, read));
    if (r.u32() !== GGUF_MAGIC) return null;
    const version = r.u32();
    r.u64(); // tensor count
    const kvCount = r.u64();
    const meta = { version };
    const wanted = new Set([
      'general.architecture', 'general.name', 'general.size_label',
      'general.finetune', 'general.basename', 'general.file_type',
    ]);
    try {
      for (let i = 0; i < Math.min(kvCount, 128); i++) {
        const key = r.str();
        const type = r.u32();
        const val = r.value(type);
        if (wanted.has(key) || /\.(context_length|block_count|expert_count)$/.test(key)) {
          meta[key.replace(/^[^.]+\.(context_length|block_count|expert_count)$/, '$1')] =
            wanted.has(key) ? val : val;
          if (wanted.has(key)) meta[key] = val;
          else if (/context_length$/.test(key)) meta.contextLength = val;
          else if (/expert_count$/.test(key)) meta.expertCount = val;
        }
      }
    } catch { /* stopped at vocab or truncated buffer — fine */ }
    return meta;
  } catch {
    return null;
  } finally {
    fs.closeSync(fd);
  }
}

const QUANT_RE = /(IQ[1-4]_[A-Z_]+|Q[2-8]_K_?[SML]?|Q[2-8]_[01]|BF16|F16|F32|MXFP4)/i;

function classify(name) {
  const n = name.toLowerCase();
  const tags = [];
  if (/(coder|codestral|starcoder|codellama|codegeex|deepseek-?coder|devstral)/.test(n)) tags.push('coding');
  if (/(-vl|vision|llava|minicpm-v|pixtral)/.test(n)) tags.push('vision');
  if (/(instruct|-it\b|-it-|chat|assistant)/.test(n)) tags.push('chat');
  if (/(qwen|llama-?3|llama3|mistral|ministral|hermes|functionary|command-r|glm|deepseek|granite|phi-4|gemma-?3|gpt-oss|nemotron|smollm)/.test(n)) tags.push('tools');
  if (/(embed|bge-|e5-)/.test(n)) tags.push('embedding');
  if (tags.length === 0) tags.push('chat');
  return tags;
}

function advise(model, vramGB, ramGB) {
  const gb = model.sizeBytes / 1024 ** 3;
  const vramBudget = vramGB * 0.88; // leave room for KV cache
  let fit, fitNote;
  if (gb <= vramBudget) {
    fit = 'gpu';
    fitNote = `Fits fully in ${vramGB} GB VRAM — fastest option.`;
  } else if (gb <= ramGB * 0.75) {
    fit = 'hybrid';
    fitNote = `Larger than VRAM; will run split across GPU + RAM (slower).`;
  } else {
    fit = 'too-big';
    fitNote = `Likely too large for this machine (${Math.round(gb)} GB file).`;
  }
  const tags = model.tags;
  const uses = [];
  if (tags.includes('coding')) uses.push('Coding agent');
  if (tags.includes('tools') && !tags.includes('embedding')) uses.push('Desktop agent (tool calling)');
  if (tags.includes('chat')) uses.push('General chat');
  if (tags.includes('vision')) uses.push('Vision / image understanding');
  if (tags.includes('embedding')) uses.push('Embeddings only');
  return { fit, fitNote, uses };
}

function scan(dirs, vramGB, ramGB) {
  const found = [];
  const walk = (dir, depth) => {
    if (depth > 4) return;
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p, depth + 1);
      else if (e.isFile() && /\.gguf$/i.test(e.name) && !/^mmproj/i.test(e.name)) {
        // skip non-first shards of split models
        if (/-\d{5}-of-\d{5}\.gguf$/i.test(e.name) && !/-00001-of-\d{5}\.gguf$/i.test(e.name)) continue;
        let st;
        try { st = fs.statSync(p); } catch { continue; }
        const meta = parseGguf(p) || {};
        const quant = (e.name.match(QUANT_RE) || [])[0] || meta['general.size_label'] || '';
        const m = {
          path: p,
          file: e.name,
          name: meta['general.name'] || e.name.replace(/\.gguf$/i, ''),
          arch: meta['general.architecture'] || '',
          contextLength: meta.contextLength || 0,
          quant: quant.toUpperCase(),
          sizeBytes: st.size,
          tags: classify(e.name + ' ' + (meta['general.name'] || '')),
        };
        m.advice = advise(m, vramGB, ramGB);
        found.push(m);
      }
    }
  };
  for (const d of dirs) walk(d, 0);
  found.sort((a, b) => a.name.localeCompare(b.name));
  return found;
}

// Best pick per purpose: prefer largest model that still fits fully in VRAM.
function suggest(models) {
  const fitting = models.filter((m) => m.advice.fit === 'gpu');
  const pick = (pred) => {
    const pool = fitting.filter(pred);
    pool.sort((a, b) => b.sizeBytes - a.sizeBytes);
    return pool[0] || null;
  };
  return {
    chat: pick((m) => m.tags.includes('chat') && !m.tags.includes('embedding')),
    coding: pick((m) => m.tags.includes('coding')) || pick((m) => m.tags.includes('tools')),
    agent: pick((m) => m.tags.includes('tools')),
  };
}

module.exports = { scan, suggest };
