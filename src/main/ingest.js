'use strict';
// Attachment pipeline: turn a file path or URL into plain text the model can read.
// Images and image-only PDFs are flagged `needsOcr` rather than silently returning
// nothing — the renderer then offers to run them through the OCR task.
const fs = require('fs');
const os = require('os');
const path = require('path');
const extract = require('./extract');

const IMAGE_EXT = new Set(['.png', '.jpg', '.jpeg', '.webp', '.bmp', '.gif', '.tif', '.tiff']);
const OOXML_EXT = new Set(['.docx', '.xlsx', '.pptx', '.docm', '.xlsm', '.pptm']);
const TEXT_EXT = new Set([
  '.txt', '.md', '.markdown', '.csv', '.tsv', '.json', '.jsonl', '.log', '.xml', '.yml', '.yaml',
  '.ini', '.cfg', '.conf', '.env', '.sql', '.rst', '.tex', '.srt', '.vtt',
  '.js', '.mjs', '.cjs', '.ts', '.tsx', '.jsx', '.py', '.rb', '.go', '.rs', '.java', '.kt',
  '.c', '.h', '.cpp', '.hpp', '.cs', '.php', '.swift', '.sh', '.ps1', '.bat', '.psm1',
  '.html', '.htm', '.css', '.scss', '.vue', '.svelte', '.toml', '.gradle', '.make', '.cmake',
]);

// Enough for a long report at 16k+ context; the caller reports when it bites.
const MAX_CHARS = 300000;

function cap(text) {
  if (text.length <= MAX_CHARS) return { text, truncated: false };
  return {
    text: text.slice(0, MAX_CHARS) + `\n\n[… truncated: ${text.length - MAX_CHARS} more characters]`,
    truncated: true,
  };
}

function looksBinary(buf) {
  const n = Math.min(buf.length, 4096);
  let bad = 0;
  for (let i = 0; i < n; i++) {
    const b = buf[i];
    if (b === 0) return true;
    if (b < 9 || (b > 13 && b < 32)) bad++;
  }
  return bad / Math.max(n, 1) > 0.12;
}

async function ingestFile(filePath) {
  const st = fs.statSync(filePath);
  if (st.isDirectory()) throw new Error('That is a folder, not a file.');
  const ext = path.extname(filePath).toLowerCase();
  const base = {
    name: path.basename(filePath),
    path: filePath,
    sizeBytes: st.size,
    ext,
  };

  if (IMAGE_EXT.has(ext)) {
    return { ...base, kind: 'image', text: '', chars: 0, needsOcr: true,
      note: 'Image — run OCR to read its text.' };
  }

  if (ext === '.pdf') {
    let r;
    try { r = extract.pdfText(filePath); }
    catch (e) { throw new Error(`Could not read PDF: ${e.message}`); }
    const thin = r.text.replace(/\s/g, '').length < 40 * (r.pages || 1);
    const garbled = r.text.length > 40 && r.quality < 0.55;
    const needsOcr = thin || garbled;
    const { text, truncated } = cap(r.text);
    return {
      ...base, kind: 'pdf', text, chars: r.text.length, pages: r.pages, truncated, needsOcr,
      quality: Math.round(r.quality * 100) / 100,
      note: needsOcr
        ? (thin ? 'No embedded text — looks like a scanned PDF. Run OCR.'
                : 'Embedded text decoded poorly (custom font encoding). OCR will be more reliable.')
        : null,
    };
  }

  if (OOXML_EXT.has(ext)) {
    let r;
    try { r = extract.ooxmlText(filePath); }
    catch (e) { throw new Error(`Could not read ${ext}: ${e.message}`); }
    const { text, truncated } = cap(r.text);
    return { ...base, kind: r.kind, text, chars: r.text.length, truncated, needsOcr: false };
  }

  if (ext === '.doc') {
    throw new Error('Legacy .doc is not supported — save it as .docx (or export to PDF) first.');
  }

  const buf = fs.readFileSync(filePath);
  if (!TEXT_EXT.has(ext) && looksBinary(buf)) {
    throw new Error(`${ext || 'This file'} looks binary — no text to extract.`);
  }
  let raw = buf.toString('utf8');
  if (ext === '.html' || ext === '.htm') raw = extract.htmlToText(raw).text;
  const { text, truncated } = cap(raw);
  return { ...base, kind: ext === '.html' || ext === '.htm' ? 'html' : 'text',
    text, chars: raw.length, truncated, needsOcr: false };
}

async function ingestUrl(url) {
  if (!/^https?:\/\//i.test(url)) url = 'https://' + url;
  let res;
  try {
    res = await fetch(url, {
      redirect: 'follow',
      signal: AbortSignal.timeout(30000),
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; LlamaDesk/2.1)', Accept: '*/*' },
    });
  } catch (e) {
    throw new Error(`Could not fetch ${url}: ${e.message}`);
  }
  if (!res.ok) throw new Error(`${url} returned HTTP ${res.status}`);
  const ctype = (res.headers.get('content-type') || '').toLowerCase();

  // PDFs served over HTTP: save to a temp file and run the PDF path
  if (ctype.includes('application/pdf') || /\.pdf($|\?)/i.test(url)) {
    const tmp = path.join(os.tmpdir(), `llamadesk-${Date.now()}.pdf`);
    fs.writeFileSync(tmp, Buffer.from(await res.arrayBuffer()));
    try {
      const r = await ingestFile(tmp);
      return { ...r, name: url.split('/').pop() || url, path: tmp, url, kind: 'pdf', source: 'url' };
    } finally { /* temp file left for the OCR path; OS cleans %TEMP% */ }
  }

  if (ctype.startsWith('image/')) {
    const ext = (ctype.split('/')[1] || 'png').split(';')[0].replace('jpeg', 'jpg');
    const tmp = path.join(os.tmpdir(), `llamadesk-${Date.now()}.${ext}`);
    fs.writeFileSync(tmp, Buffer.from(await res.arrayBuffer()));
    return { name: url.split('/').pop() || url, path: tmp, url, kind: 'image', source: 'url',
      text: '', chars: 0, needsOcr: true, note: 'Image from URL — run OCR to read its text.' };
  }

  const body = await res.text();
  const isHtml = ctype.includes('html') || /^\s*<(!doctype|html)/i.test(body);
  const parsed = isHtml ? extract.htmlToText(body) : { title: null, text: body };
  const { text, truncated } = cap(parsed.text);
  return {
    name: parsed.title || url,
    url, path: null, source: 'url',
    kind: isHtml ? 'web' : 'text',
    text, chars: parsed.text.length, truncated, needsOcr: false,
    sizeBytes: Buffer.byteLength(body),
  };
}

// Render attachments into a block for the model's context.
function toPromptBlock(attachments) {
  const usable = attachments.filter((a) => a.text && a.text.trim());
  if (!usable.length) return '';
  const parts = usable.map((a) => {
    const where = a.url || a.path || a.name;
    const meta = [a.kind, a.pages ? `${a.pages} pages` : null, `${a.chars} chars`]
      .filter(Boolean).join(', ');
    return `<attachment name="${a.name}" source="${where}" type="${meta}">\n${a.text}\n</attachment>`;
  });
  return `The user attached the following. Use it as the source of truth for this request.\n\n${parts.join('\n\n')}`;
}

module.exports = { ingestFile, ingestUrl, toPromptBlock, MAX_CHARS };
