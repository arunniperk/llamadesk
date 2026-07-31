// Extraction/ingestion tests: builds real PDF + DOCX + HTML fixtures and checks the
// pure-JS extractors recover the known text. Run: npx electron scripts/test-extract.js
const { app } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const zlib = require('zlib');

let failed = 0;
const check = (label, cond, extra) => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}${extra ? '  → ' + extra : ''}`);
  if (!cond) failed++;
};

// ---- fixture builders (no external tools) ----
function makePdf(file, lines, { compress = true } = {}) {
  const content = 'BT /F1 12 Tf 72 720 Td 14 TL\n' +
    lines.map((l) => `(${l.replace(/([()\\])/g, '\\$1')}) Tj T*`).join('\n') + '\nET';
  const stream = compress ? zlib.deflateSync(Buffer.from(content, 'latin1')) : Buffer.from(content, 'latin1');
  const objs = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>',
    null, // stream object, built below
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ];
  let out = Buffer.from('%PDF-1.4\n', 'latin1');
  const offsets = [];
  for (let i = 0; i < objs.length; i++) {
    offsets.push(out.length);
    if (i === 3) {
      const head = Buffer.from(`4 0 obj\n<< /Length ${stream.length}${compress ? ' /Filter /FlateDecode' : ''} >>\nstream\n`, 'latin1');
      out = Buffer.concat([out, head, stream, Buffer.from('\nendstream\nendobj\n', 'latin1')]);
    } else {
      out = Buffer.concat([out, Buffer.from(`${i + 1} 0 obj\n${objs[i]}\nendobj\n`, 'latin1')]);
    }
  }
  const xref = out.length;
  let x = `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n`;
  for (const o of offsets) x += String(o).padStart(10, '0') + ' 00000 n \n';
  x += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  fs.writeFileSync(file, Buffer.concat([out, Buffer.from(x, 'latin1')]));
}

// Minimal ZIP writer (stored + deflated entries) to build a .docx
function makeZip(file, entries) {
  const locals = [], central = [];
  let offset = 0;
  const crcTable = (() => {
    const t = new Int32Array(256);
    for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? -306674912 ^ (c >>> 1) : c >>> 1; t[n] = c; }
    return t;
  })();
  const crc32 = (buf) => {
    let c = -1;
    for (let i = 0; i < buf.length; i++) c = crcTable[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
    return (c ^ -1) >>> 0;
  };
  for (const [name, contentStr] of Object.entries(entries)) {
    const raw = Buffer.from(contentStr, 'utf8');
    const comp = zlib.deflateRawSync(raw);
    const nameBuf = Buffer.from(name, 'utf8');
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(20, 4); lh.writeUInt16LE(8, 8);
    lh.writeUInt32LE(crc32(raw), 14); lh.writeUInt32LE(comp.length, 18);
    lh.writeUInt32LE(raw.length, 22); lh.writeUInt16LE(nameBuf.length, 26);
    locals.push(Buffer.concat([lh, nameBuf, comp]));
    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0); ch.writeUInt16LE(20, 4); ch.writeUInt16LE(20, 6);
    ch.writeUInt16LE(8, 10); ch.writeUInt32LE(crc32(raw), 16);
    ch.writeUInt32LE(comp.length, 20); ch.writeUInt32LE(raw.length, 24);
    ch.writeUInt16LE(nameBuf.length, 28); ch.writeUInt32LE(offset, 42);
    central.push(Buffer.concat([ch, nameBuf]));
    offset += lh.length + nameBuf.length + comp.length;
  }
  const cd = Buffer.concat(central);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(central.length, 8); eocd.writeUInt16LE(central.length, 10);
  eocd.writeUInt32LE(cd.length, 12); eocd.writeUInt32LE(offset, 16);
  fs.writeFileSync(file, Buffer.concat([...locals, cd, eocd]));
}

app.whenReady().then(async () => {
  const extract = require(path.join(__dirname, '..', 'src', 'main', 'extract.js'));
  const ingest = require(path.join(__dirname, '..', 'src', 'main', 'ingest.js'));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ld-extract-'));

  try {
    // ---------- PDF ----------
    console.log('\n-- PDF --');
    const LINES = ['Quarterly Field Report', 'Serial: RX-9070-XT-44821', 'Total cost: Rs 47,250 (approx USD 565)'];
    const pdf = path.join(dir, 'report.pdf');
    makePdf(pdf, LINES);
    const p = extract.pdfText(pdf);
    for (const l of LINES) check(`pdf recovers: ${l.slice(0, 32)}`, p.text.includes(l), p.text.slice(0, 60).replace(/\n/g, '|'));
    check('pdf counts 1 page', p.pages === 1, String(p.pages));
    check('pdf quality is high for real text', p.quality > 0.8, String(p.quality));
    check('pdf lines are separated', p.text.split('\n').length >= 3, JSON.stringify(p.text.slice(0, 80)));

    const pdfRaw = path.join(dir, 'raw.pdf');
    makePdf(pdfRaw, ['Uncompressed stream works'], { compress: false });
    check('pdf without FlateDecode', extract.pdfText(pdfRaw).text.includes('Uncompressed stream works'));

    // parens + escapes
    const pdfEsc = path.join(dir, 'esc.pdf');
    makePdf(pdfEsc, ['Nested (parens) and a backslash \\ here']);
    check('pdf handles escaped parens/backslash',
      extract.pdfText(pdfEsc).text.includes('Nested (parens) and a backslash \\ here'),
      JSON.stringify(extract.pdfText(pdfEsc).text));

    // ---------- scanned-PDF detection ----------
    console.log('\n-- scanned PDF detection --');
    const empty = path.join(dir, 'scan.pdf');
    fs.writeFileSync(empty, Buffer.concat([
      Buffer.from('%PDF-1.4\n1 0 obj\n<< /Type /Page /Contents 2 0 R >>\nendobj\n', 'latin1'),
      Buffer.from('2 0 obj\n<< /Subtype /Image /Filter /DCTDecode /Length 4 >>\nstream\n', 'latin1'),
      Buffer.from([0xff, 0xd8, 0xff, 0xd9]),
      Buffer.from('\nendstream\nendobj\ntrailer\n<< /Root 1 0 R >>\n%%EOF\n', 'latin1'),
    ]));
    const scanned = await ingest.ingestFile(empty);
    check('image-only PDF flagged needsOcr', scanned.needsOcr === true);
    check('  ...with an explanatory note', /scanned|OCR/i.test(scanned.note || ''), scanned.note);

    // ---------- DOCX ----------
    console.log('\n-- DOCX --');
    const docx = path.join(dir, 'memo.docx');
    makeZip(docx, {
      '[Content_Types].xml': '<?xml version="1.0"?><Types/>',
      'word/document.xml': '<?xml version="1.0"?><w:document><w:body>' +
        '<w:p><w:r><w:t>Heading of the memo</w:t></w:r></w:p>' +
        '<w:p><w:r><w:t>Amount due is </w:t></w:r><w:r><w:t>1,250 &amp; rising</w:t></w:r></w:p>' +
        '</w:body></w:document>',
    });
    const d = await ingest.ingestFile(docx);
    check('docx kind', d.kind === 'docx', d.kind);
    check('docx recovers heading', d.text.includes('Heading of the memo'), JSON.stringify(d.text));
    check('docx joins runs in a paragraph', d.text.includes('Amount due is 1,250 & rising'), JSON.stringify(d.text));
    check('docx splits paragraphs', d.text.split('\n').filter(Boolean).length === 2, JSON.stringify(d.text));

    // ---------- PPTX ----------
    const pptx = path.join(dir, 'deck.pptx');
    makeZip(pptx, {
      'ppt/slides/slide1.xml': '<p:sld><a:p><a:r><a:t>First slide title</a:t></a:r></a:p></p:sld>',
      'ppt/slides/slide2.xml': '<p:sld><a:p><a:r><a:t>Second slide body</a:t></a:r></a:p></p:sld>',
    });
    const pp = await ingest.ingestFile(pptx);
    check('pptx reads both slides',
      pp.text.includes('First slide title') && pp.text.includes('Second slide body'), pp.kind);

    // ---------- HTML ----------
    console.log('\n-- HTML --');
    const h = extract.htmlToText(
      '<html><head><title>Doc Title</title><style>p{color:red}</style>' +
      '<script>var x="<p>not text</p>";</script></head>' +
      '<body><h1>Big Heading</h1><p>Para one.</p><ul><li>alpha</li><li>beta</li></ul></body></html>');
    check('html title', h.title === 'Doc Title', h.title);
    check('html drops script/style', !/not text|color:red/.test(h.text), JSON.stringify(h.text));
    check('html keeps content', /Big Heading[\s\S]*Para one[\s\S]*alpha[\s\S]*beta/.test(h.text), JSON.stringify(h.text));

    // ---------- plain + binary ----------
    console.log('\n-- plain text & guards --');
    const txt = path.join(dir, 'notes.md');
    fs.writeFileSync(txt, '# Title\n\nSome **notes** here.');
    const t = await ingest.ingestFile(txt);
    check('markdown read verbatim', t.text.includes('Some **notes** here.') && t.kind === 'text');

    const img = path.join(dir, 'photo.png');
    fs.writeFileSync(img, Buffer.from([0x89, 0x50, 0x4e, 0x47, 13, 10, 26, 10]));
    const im = await ingest.ingestFile(img);
    check('image flagged needsOcr, no text', im.needsOcr === true && im.kind === 'image');

    const bin = path.join(dir, 'blob.dat');
    fs.writeFileSync(bin, Buffer.from(Array.from({ length: 800 }, (_, i) => i % 251)));
    let threw = null;
    try { await ingest.ingestFile(bin); } catch (e) { threw = e; }
    check('binary file rejected with a clear message', !!threw && /binary/i.test(threw.message), threw && threw.message);

    let docErr = null;
    fs.writeFileSync(path.join(dir, 'old.doc'), 'x');
    try { await ingest.ingestFile(path.join(dir, 'old.doc')); } catch (e) { docErr = e; }
    check('.doc gives actionable advice', !!docErr && /docx/i.test(docErr.message), docErr && docErr.message);

    // ---------- decode-quality gate ----------
    // Regression for a real failure: a PDF with CID/custom font encoding decodes to
    // letters — just the WRONG letters — and scored 0.78 on the old printable-char
    // heuristic while sharing 0% of its words with the true text. Measured against
    // real PDFs, good decodes now score 0.89-0.94 and that garbage scores 0.28.
    console.log('\n-- decode quality gate --');
    const prose = 'The purpose of this document is to set out the rules and regulations that ' +
      'shall apply to all residents, and to describe the process by which a complaint can be made.';
    // vowel-poor, stop-word-free letter soup, i.e. what a CID mis-decode looks like
    const garbage = 'tzq rkgm bpfhq wntxr kdvpq zbtrm nqxwd fgtkp mrqzv btnhx wkdqp zrmgt ' +
      'nxbfq kwptr dmzqg hbxnw qtkrp vzmdt gqnbx wrkpf tzdmq nhbwx qkrtp';
    const german = 'Die Bestimmungen dieser Vereinbarung gelten fuer alle Bewohner und ' +
      'beschreiben das Verfahren, mit dem eine Beschwerde eingereicht werden kann.';

    const qProse = extract.textQuality(prose);
    const qGarbage = extract.textQuality(garbage);
    const qGerman = extract.textQuality(german);
    check('real prose scores high', qProse >= 0.8, String(qProse));
    check('CID garbage scores low', qGarbage < 0.5, String(qGarbage));
    check('gate separates them', qProse - qGarbage > 0.35, `${qProse} vs ${qGarbage}`);
    check('non-English prose is NOT flagged as garbage', qGerman >= 0.55, String(qGerman));
    check('short text falls back without crying garbage', extract.textQuality('Hi there, ok.') >= 0);

    // a PDF whose text decodes to garbage must be routed to OCR
    const pdfBad = path.join(dir, 'cid.pdf');
    makePdf(pdfBad, [garbage, garbage]);
    const bad = await ingest.ingestFile(pdfBad);
    check('garbled PDF flagged needsOcr', bad.needsOcr === true, `quality=${bad.quality}`);
    check('  ...and says why', /encoding|OCR/i.test(bad.note || ''), bad.note);

    const pdfGood = path.join(dir, 'prose.pdf');
    makePdf(pdfGood, [prose]);
    const good = await ingest.ingestFile(pdfGood);
    check('clean PDF NOT flagged needsOcr', good.needsOcr === false, `quality=${good.quality}`);

    // ---------- prompt block ----------
    console.log('\n-- prompt block --');
    const block = ingest.toPromptBlock([t, im, d]);
    check('block includes text attachments', block.includes('Some **notes** here.'));
    check('block skips the empty image', !block.includes('photo.png'), block.slice(0, 120));
    check('block tags each attachment', (block.match(/<attachment /g) || []).length === 2);
    check('empty list yields empty block', ingest.toPromptBlock([im]) === '');
  } catch (err) {
    check('unexpected exception', false, String((err && err.stack) || err));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }

  console.log(failed ? `\n${failed} FAILED` : '\nall checks passed');
  app.exit(failed ? 1 : 0);
});
