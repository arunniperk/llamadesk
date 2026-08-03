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
          // Consume without storing rather than aborting: on some architectures (Gemma 4)
          // the attention shape keys sit *after* the tokenizer arrays, and bailing here
          // left us unable to size the KV cache.
          for (let i = 0; i < n; i++) this.value(t);
          return null;
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

// Two-tier read: 2 MB covers most headers. If the shape keys needed to size the KV cache sit
// past a big tokenizer array (Gemma), retry with a larger window rather than guessing.
function parseGguf(filePath) {
  const fast = parseGgufWith(filePath, 2 * 1024 * 1024);
  if (fast && !fast.blockCount) {
    const deep = parseGgufWith(filePath, 24 * 1024 * 1024);
    if (deep && deep.blockCount) return deep;
  }
  return fast;
}

function parseGgufWith(filePath, bufSize) {
  const fd = fs.openSync(filePath, 'r');
  try {
    const buf = Buffer.alloc(bufSize);
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
      for (let i = 0; i < Math.min(kvCount, 512); i++) {
        const key = r.str();
        const type = r.u32();
        const val = r.value(type);
        if (wanted.has(key)) meta[key] = val;
        // architecture-prefixed shape keys, needed for the KV-cache size calculation
        else if (/\.context_length$/.test(key)) meta.contextLength = val;
        else if (/\.expert_count$/.test(key)) meta.expertCount = val;
        else if (/\.expert_used_count$/.test(key)) meta.expertUsedCount = val;
        else if (/\.block_count$/.test(key)) meta.blockCount = val;
        else if (/\.embedding_length$/.test(key)) meta.embeddingLength = val;
        else if (/\.attention\.head_count$/.test(key)) meta.headCount = val;
        else if (/\.attention\.head_count_kv$/.test(key)) meta.headCountKv = val;
        else if (/\.attention\.key_length$/.test(key)) meta.keyLength = val;
        // sliding-window layers keep a fixed window, so they don't grow with context
        else if (/\.attention\.sliding_window$/.test(key)) meta.slidingWindow = val;
        else if (/\.attention\.sliding_window_pattern$/.test(key)) meta.swaPattern = val;
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

// Bytes of KV cache per token of context, at f16. This is what actually bounds context
// length: it scales linearly with n_ctx, so "max context" is a memory question. Returns 0
// when the header didn't give us enough shape information.
function kvBytesPerToken(meta) {
  const layers = meta.blockCount;
  if (!layers) return 0;
  // head_count_kv is a scalar on most architectures but a per-layer array on some (Gemma 4);
  // multiplying an array by block_count yields NaN, which is falsy and silently disables
  // the whole check — sum it instead.
  const perLayer = Array.isArray(meta.headCountKv) ? meta.headCountKv : null;
  const flatHeads = perLayer ? 0 : (meta.headCountKv || meta.headCount);
  let headDim = meta.keyLength;
  if (!headDim && meta.embeddingLength && meta.headCount) headDim = meta.embeddingLength / meta.headCount;
  if (!headDim || (!perLayer && !flatHeads)) return 0;
  const swa = Array.isArray(meta.swaPattern) ? meta.swaPattern : null;
  let heads = 0;
  for (let i = 0; i < layers; i++) {
    if (swa && swa[i]) continue; // window-bounded: constant, not proportional to n_ctx
    heads += perLayer ? (Number(perLayer[i]) || 0) : flatHeads;
  }
  if (!heads) return 0;
  return 2 /* K and V */ * heads * headDim * 2 /* f16 */;
}

// Largest context this model can actually be served at, given its weights and a VRAM
// budget — capped at the context it was trained for.
function maxContextFor(model, vramGB) {
  const trained = model.contextLength || 0;
  const perToken = model.kvBytesPerToken || 0;
  if (!perToken) return trained; // unknown shape — trust the trained value only
  const free = vramGB * 1024 ** 3 - model.sizeBytes - 1.2 * 1024 ** 3 /* compute buffers */;
  if (free <= 0) return 0;
  const fits = Math.floor(free / perToken / 256) * 256;
  return trained ? Math.min(trained, fits) : fits;
}

// Short badges for the sidebar: what kind of model this is at a glance.
function labelsFor(m, meta) {
  const out = [];
  if (meta.expertCount > 0) {
    out.push(meta.expertUsedCount
      ? `MoE ${meta.expertUsedCount}/${meta.expertCount}`
      : `MoE ${meta.expertCount}`);
  }
  if (m.vision) out.push('Vision');
  const c = m.caps || {};
  if (c.embedding >= 8) out.push('Embedding');
  if (c.vision === 0 && c.coding >= 8) out.push('Coder');
  if (c.reasoning >= 9) out.push('Reasoning');
  if (c.uncensored >= 8) out.push('Uncensored');
  if (meta.swaPattern) out.push('SWA');
  if (m.contextLength >= 128000) out.push(`${Math.round(m.contextLength / 1024)}k ctx`);
  return out;
}

function classify(name) {
  const n = name.toLowerCase();
  const tags = [];
  if (/(coder|codestral|starcoder|codellama|codegeex|deepseek-?coder|devstral)/.test(n)) tags.push('coding');
  if (/(-vl|vision|llava|minicpm-v|pixtral|ocr)/.test(n)) tags.push('vision');
  if (/(instruct|-it\b|-it-|chat|assistant)/.test(n)) tags.push('chat');
  if (/(qwen|llama-?3|llama3|mistral|ministral|hermes|functionary|command-r|glm|deepseek|granite|phi-4|gemma-?3|gpt-oss|nemotron|smollm)/.test(n)) tags.push('tools');
  if (/(embed|bge-|e5-)/.test(n)) tags.push('embedding');
  if (tags.length === 0) tags.push('chat');
  return tags;
}

// A 0-10 capability profile per model, inferred from name, architecture, context
// length and parameter size. Deliberately heuristic — it ranks what the user
// actually has on disk, it does not pretend to be a benchmark.
function capabilities(m) {
  const n = (m.file + ' ' + m.name).toLowerCase();
  const params = paramB(m);           // rough parameter count in billions
  const scale = Math.min(10, 2 + Math.log2(Math.max(params, 1)) * 2.2); // 3B≈5.5, 14B≈10
  const caps = { coding: 0, tools: 0, reasoning: 0, creative: 0, longctx: 0, vision: 0, uncensored: 0, embedding: 0 };

  if (/(embed|bge-|e5-|gte-)/.test(n)) { caps.embedding = 10; return caps; }

  const isCoder = /(coder|codestral|starcoder|codellama|codegeex|deepseek-?coder|devstral|code)/.test(n);
  // An mmproj-*.gguf beside the model is PROOF of vision capability; the filename is only a
  // guess. Trust the proof first — otherwise a projector-shipping model whose name lacks a
  // vision word (e.g. Huihui-Qwythos-9B) is badged "Vision" in the sidebar while the OCR
  // task refuses it, because labelsFor() reads m.vision but the OCR gate reads caps.vision.
  const isVision = m.vision === true || /(-vl|vision|llava|minicpm-v|pixtral|ocr|qwen.?vl)/.test(n);
  const isReasoner = /(reason|thinking|-r1|deepseek-r1|qwq|thinkingcap|o1|marco-o1)/.test(n);
  const isUncensored = /(abliterat|uncensored|dolphin|heretic|unrestricted)/.test(n);
  const knownToolFamily = /(qwen|llama-?3|mistral|ministral|hermes|functionary|command-r|glm|deepseek|granite|phi-[34]|gemma-?[34]|gpt-oss|nemotron|smollm|ornith|mythos)/.test(n);

  caps.coding = isCoder ? Math.min(10, scale + 2) : scale * 0.55;
  caps.tools = knownToolFamily ? scale * 0.9 : scale * 0.4;
  caps.reasoning = isReasoner ? Math.min(10, scale + 2) : scale * 0.7;
  caps.creative = scale * 0.6 + (isUncensored ? 3 : 0);
  caps.vision = isVision ? Math.min(10, scale + 3) : 0;
  caps.uncensored = isUncensored ? 10 : 0;

  // context length is a real, measured property — use it directly
  const ctx = m.contextLength || 0;
  caps.longctx = ctx >= 500000 ? 10 : ctx >= 200000 ? 9 : ctx >= 128000 ? 8
    : ctx >= 64000 ? 6 : ctx >= 32000 ? 4.5 : ctx >= 16000 ? 3 : ctx > 0 ? 1.5 : 2;

  for (const k of Object.keys(caps)) caps[k] = Math.round(Math.min(10, caps[k]) * 10) / 10;
  return caps;
}

// Parameter count in billions, from the size label / filename, else from file size.
function paramB(m) {
  const hay = (m.file + ' ' + m.name).replace(/,/g, '');
  // "35B-A3B" → treat as its ACTIVE size for speed-ish scaling but total for capability;
  // capability tracks total, which is the first number.
  const tag = hay.match(/(\d+(?:\.\d+)?)\s*x\s*(\d+(?:\.\d+)?)\s*([bm])\b/i); // 64x550M
  if (tag) {
    const each = parseFloat(tag[2]) * (tag[3].toLowerCase() === 'm' ? 0.001 : 1);
    return parseFloat(tag[1]) * each;
  }
  const b = hay.match(/(\d+(?:\.\d+)?)\s*b\b/i);
  if (b) return parseFloat(b[1]);
  // fall back to file size: ~0.6 GB per B at Q4-ish
  return Math.max(0.5, m.sizeBytes / 1024 ** 3 / 0.6);
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
  // An mmproj-*.gguf beside a model is the vision projector: proof of vision capability,
  // where the name-based caps.vision guess is only an inference. Same pairing ocr.js uses.
  const projectors = new Map(); // dir -> projector path
  const walk = (dir, depth) => {
    if (depth > 4) return;
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (e.isFile() && /^mmproj.*\.gguf$/i.test(e.name) && !projectors.has(dir)) {
        projectors.set(dir, path.join(dir, e.name));
      }
    }
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
        m.mmproj = projectors.get(dir) || null;
        m.vision = !!m.mmproj;
        m.advice = advise(m, vramGB, ramGB);
        m.caps = capabilities(m);
        m.kvBytesPerToken = kvBytesPerToken(meta);
        m.maxContext = maxContextFor(m, vramGB);
        m.labels = labelsFor(m, meta);
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

// ---- per-task model selection -------------------------------------------------
// Score every model against a task's capability weights, then rank. Fitting the
// GPU is worth a lot (it is the difference between fast and unusably slow), and a
// task's minimum context is a hard-ish requirement rather than a preference.
function scoreFor(m, task) {
  const wants = task.wants || {};
  const weightSum = Object.values(wants).reduce((a, b) => a + b, 0) || 1;
  let capScore = 0;
  for (const [cap, w] of Object.entries(wants)) capScore += (m.caps[cap] || 0) * w;
  capScore = capScore / weightSum; // 0..10

  // embeddings are never a chat/vision answer
  if (m.caps.embedding >= 10 && !(wants.embedding)) return { score: -1, capScore, why: 'embedding model' };

  const reasons = [];
  let score = capScore * 10; // 0..100

  if (m.advice.fit === 'gpu') { score += 22; reasons.push('fits VRAM'); }
  else if (m.advice.fit === 'hybrid') { score -= 6; reasons.push('GPU+RAM offload'); }
  else { score -= 40; reasons.push('too large for this PC'); }

  const ctx = m.contextLength || 0;
  if (task.minCtx && ctx > 0 && ctx < task.minCtx) {
    score -= 25;
    reasons.push(`context ${Math.round(ctx / 1024)}k < ${Math.round(task.minCtx / 1024)}k needed`);
  }
  if (task.kind === 'ocr' && m.caps.vision <= 0) return { score: -1, capScore, why: 'not a vision model' };

  return { score: Math.round(score * 10) / 10, capScore: Math.round(capScore * 10) / 10, reasons };
}

// Ranked candidates for a task. `top` is the auto-pick.
function pickFor(models, task, limit = 4) {
  const ranked = models
    .map((m) => ({ model: m, ...scoreFor(m, task) }))
    .filter((r) => r.score >= 0)
    .sort((a, b) => b.score - a.score);
  return {
    top: ranked[0] || null,
    ranked: ranked.slice(0, limit),
  };
}

module.exports = { scan, suggest, capabilities, pickFor, scoreFor, kvBytesPerToken, maxContextFor, labelsFor };
