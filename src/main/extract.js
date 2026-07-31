'use strict';
// Dependency-free text extraction for PDF, DOCX/XLSX/PPTX (OOXML) and HTML.
// Everything here is pure Node + zlib so the app stays self-contained and portable —
// no pdftotext/poppler/python on the target machine.
const fs = require('fs');
const zlib = require('zlib');

// ---------------------------------------------------------------- PDF ----------
// Handles the common case: FlateDecode content streams with WinAnsi/ASCII text.
// PDFs using CID/custom-encoded embedded fonts decode to noise — `quality` below
// reports that so the caller can fall back to OCR instead of feeding gibberish
// to a model.

function pdfStrings(content) {
  // Pull literal (…) and hex <…> strings out of Tj / TJ / ' / " operators.
  const out = [];
  let i = 0;
  const n = content.length;
  while (i < n) {
    const ch = content[i];
    if (ch === '(') {
      let depth = 1, j = i + 1, s = '';
      while (j < n && depth > 0) {
        const c = content[j];
        if (c === '\\') {
          const nx = content[j + 1];
          const oct = content.slice(j + 1, j + 4);
          if (/^[0-7]{1,3}/.test(oct)) {
            const m = oct.match(/^[0-7]{1,3}/)[0];
            s += String.fromCharCode(parseInt(m, 8));
            j += 1 + m.length;
            continue;
          }
          s += { n: '\n', r: '\r', t: '\t', b: '\b', f: '\f', '(': '(', ')': ')', '\\': '\\' }[nx] ?? nx ?? '';
          j += 2;
          continue;
        }
        if (c === '(') depth++;
        if (c === ')') { depth--; if (depth === 0) break; }
        s += c;
        j++;
      }
      out.push({ text: s, at: i });
      i = j + 1;
      continue;
    }
    if (ch === '<' && content[i + 1] !== '<') {
      const end = content.indexOf('>', i);
      if (end > i) {
        const hex = content.slice(i + 1, end).replace(/[^0-9a-fA-F]/g, '');
        let s = '';
        // 4-hex-digit groups are usually 2-byte CIDs; 2-digit are bytes
        const step = hex.length % 4 === 0 && hex.length > 2 ? 4 : 2;
        for (let k = 0; k + step <= hex.length; k += step) {
          const code = parseInt(hex.substr(k, step), 16);
          if (code > 0) s += String.fromCharCode(code);
        }
        out.push({ text: s, at: i });
        i = end + 1;
        continue;
      }
    }
    i++;
  }
  return out;
}

function pdfContentToText(content) {
  // Insert line breaks at text-positioning operators so lines don't run together.
  const lineOps = /(T\*|Td|TD|TL|'|")/g;
  const marks = [];
  let m;
  while ((m = lineOps.exec(content))) marks.push(m.index);

  const strings = pdfStrings(content);
  if (!strings.length) return '';
  let out = '';
  let markIdx = 0;
  let prevAt = -1;
  for (const s of strings) {
    // count positioning ops that occurred between the previous string and this one
    let breaks = 0;
    while (markIdx < marks.length && marks[markIdx] < s.at) {
      if (marks[markIdx] > prevAt) breaks++;
      markIdx++;
    }
    if (out && breaks > 0) out += '\n';
    out += s.text;
    prevAt = s.at;
  }
  return out;
}

// Common English function words — the strongest cheap signal that a decode worked.
const STOP = new Set(['the', 'and', 'of', 'to', 'in', 'is', 'for', 'that', 'with', 'are', 'this',
  'be', 'as', 'on', 'by', 'an', 'it', 'from', 'at', 'or', 'we', 'can', 'has', 'was', 'which',
  'not', 'all', 'any', 'may', 'shall', 'will', 'have', 'been', 'their', 'its', 'such', 'if']);

// Does this text look like a *correct* decode?
//
// The naive "how many printable characters" test does not work: a PDF whose fonts use a
// custom/CID encoding decodes to letters, just the WRONG letters, and scores ~0.8 while
// sharing 0% of its words with the real content. Measured across real PDFs, the separation
// is stark — good decodes run 25-31% stop-words and 84-92% words-containing-a-vowel, a CID
// garbage decode ran 0.02% and 40%. Vowel rate leads because it survives non-English text
// (where English stop words legitimately vanish); stop words add confidence on top.
function textQuality(s) {
  if (!s || s.length < 40) return 0;
  const words = s.toLowerCase().match(/[a-z']+/g) || [];

  // Too few Latin words to judge lexically (short text, or a non-Latin script):
  // fall back to a printable-character ratio and don't cry garbage.
  if (words.length < 20) {
    const sane = (s.match(/[A-Za-z0-9\s.,;:'"()\-–—/&%$£€@#!?+*=\[\]{}<>|\\_`~^]/g) || []).length;
    return Math.round(Math.min(1, sane / s.length) * 100) / 100;
  }

  const vowelRatio = words.filter((w) => /[aeiou]/.test(w)).length / words.length;
  const stopRatio = words.filter((w) => STOP.has(w)).length / words.length;
  const score = 0.7 * vowelRatio + 0.3 * Math.min(1, stopRatio / 0.15);
  return Math.round(Math.min(1, score) * 100) / 100;
}

function pdfText(filePath) {
  const buf = fs.readFileSync(filePath);
  const pages = (buf.toString('latin1').match(/\/Type\s*\/Page[^s]/g) || []).length || null;

  const chunks = [];
  let pos = 0;
  while (true) {
    const sIdx = buf.indexOf('stream', pos);
    if (sIdx < 0) break;
    const eIdx = buf.indexOf('endstream', sIdx);
    if (eIdx < 0) break;

    // dictionary immediately preceding this stream tells us the filter
    const dictStart = Math.max(0, sIdx - 800);
    const dict = buf.toString('latin1', dictStart, sIdx);

    let dataStart = sIdx + 6;
    while (dataStart < buf.length && (buf[dataStart] === 0x0d || buf[dataStart] === 0x0a)) dataStart++;
    let dataEnd = eIdx;
    while (dataEnd > dataStart && (buf[dataEnd - 1] === 0x0d || buf[dataEnd - 1] === 0x0a)) dataEnd--;
    const raw = buf.subarray(dataStart, dataEnd);
    pos = eIdx + 9;

    // skip obvious non-text streams
    if (/\/Subtype\s*\/Image|\/DCTDecode|\/JPXDecode|\/CCITTFaxDecode/.test(dict)) continue;

    let data = null;
    if (/\/FlateDecode/.test(dict)) {
      try { data = zlib.inflateSync(raw); }
      catch { try { data = zlib.inflateRawSync(raw); } catch { continue; } }
    } else if (!/\/Filter/.test(dict)) {
      data = raw;
    } else {
      continue; // LZW/RunLength/etc — rare for content streams, not worth the code
    }

    const content = data.toString('latin1');
    if (!/(Tj|TJ)\b/.test(content)) continue;
    const t = pdfContentToText(content);
    if (t.trim()) chunks.push(t);
  }

  const text = chunks.join('\n\n').replace(/[ \t]{2,}/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
  return { text, pages, quality: textQuality(text) };
}

// -------------------------------------------------------------- OOXML ----------
// Minimal ZIP central-directory reader — enough to pull one entry out of a
// .docx/.xlsx/.pptx (all OOXML zips).
function zipEntries(buf) {
  // End of Central Directory: signature 0x06054b50, within the last 64KB
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65557); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('not a zip archive');
  const count = buf.readUInt16LE(eocd + 10);
  let off = buf.readUInt32LE(eocd + 16);

  const entries = {};
  for (let i = 0; i < count && off + 46 <= buf.length; i++) {
    if (buf.readUInt32LE(off) !== 0x02014b50) break;
    const method = buf.readUInt16LE(off + 10);
    const compSize = buf.readUInt32LE(off + 20);
    const nameLen = buf.readUInt16LE(off + 28);
    const extraLen = buf.readUInt16LE(off + 30);
    const commentLen = buf.readUInt16LE(off + 32);
    const localOff = buf.readUInt32LE(off + 42);
    const name = buf.toString('utf8', off + 46, off + 46 + nameLen);
    entries[name] = { method, compSize, localOff };
    off += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}

function zipRead(buf, entry) {
  if (buf.readUInt32LE(entry.localOff) !== 0x04034b50) throw new Error('bad local header');
  const nameLen = buf.readUInt16LE(entry.localOff + 26);
  const extraLen = buf.readUInt16LE(entry.localOff + 28);
  const start = entry.localOff + 30 + nameLen + extraLen;
  const raw = buf.subarray(start, start + entry.compSize);
  if (entry.method === 0) return raw;
  if (entry.method === 8) return zlib.inflateRawSync(raw);
  throw new Error('unsupported zip compression method ' + entry.method);
}

function xmlToText(xml, opts = {}) {
  let s = xml;
  if (opts.paraBreak) s = s.replace(new RegExp(opts.paraBreak, 'g'), '\n');
  if (opts.tabBreak) s = s.replace(new RegExp(opts.tabBreak, 'g'), '\t');
  s = s.replace(/<[^>]+>/g, '');
  s = s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&')
       .replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&#(\d+);/g, (_, d) => String.fromCharCode(+d));
  return s.replace(/[ \t]{2,}/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
}

function ooxmlText(filePath) {
  const buf = fs.readFileSync(filePath);
  const entries = zipEntries(buf);

  if (entries['word/document.xml']) {
    const xml = zipRead(buf, entries['word/document.xml']).toString('utf8');
    return { text: xmlToText(xml, { paraBreak: '</w:p>', tabBreak: '<w:tab/>' }), kind: 'docx' };
  }
  if (entries['xl/sharedStrings.xml'] || entries['xl/workbook.xml']) {
    // shared strings give the readable content of a workbook without formula plumbing
    const parts = [];
    if (entries['xl/sharedStrings.xml']) {
      parts.push(xmlToText(zipRead(buf, entries['xl/sharedStrings.xml']).toString('utf8'), { paraBreak: '</si>' }));
    }
    return { text: parts.join('\n').trim(), kind: 'xlsx' };
  }
  const slides = Object.keys(entries).filter((k) => /^ppt\/slides\/slide\d+\.xml$/.test(k))
    .sort((a, b) => (+a.match(/\d+/)[0]) - (+b.match(/\d+/)[0]));
  if (slides.length) {
    const parts = slides.map((s, i) =>
      `--- Slide ${i + 1} ---\n` + xmlToText(zipRead(buf, entries[s]).toString('utf8'), { paraBreak: '</a:p>' }));
    return { text: parts.join('\n\n').trim(), kind: 'pptx' };
  }
  throw new Error('unrecognised OOXML package');
}

// --------------------------------------------------------------- HTML ----------
function htmlToText(html) {
  let s = html;
  s = s.replace(/<script[\s\S]*?<\/script>/gi, ' ').replace(/<style[\s\S]*?<\/style>/gi, ' ');
  s = s.replace(/<!--[\s\S]*?-->/g, ' ');
  const title = (s.match(/<title[^>]*>([\s\S]*?)<\/title>/i) || [])[1];
  s = s.replace(/<\/(p|div|section|article|li|tr|h[1-6]|blockquote)>/gi, '\n');
  s = s.replace(/<br\s*\/?>/gi, '\n');
  s = s.replace(/<li[^>]*>/gi, '- ');
  s = xmlToText(s);
  s = s.replace(/\n[ \t]+/g, '\n').replace(/\n{3,}/g, '\n\n');
  return { title: title ? xmlToText(title) : null, text: s.trim() };
}

module.exports = { pdfText, ooxmlText, htmlToText, textQuality };
