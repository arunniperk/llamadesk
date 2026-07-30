// Generates build/icon.ico and build/icon.png without any external dependencies.
// Design: violet→cyan gradient rounded square, white chat bubble, dark lightning bolt.
'use strict';
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

// ---------- PNG encoder ----------
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}
function encodePNG(w, h, rgba) {
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; ihdr[9] = 6; // 8-bit RGBA
  const raw = Buffer.alloc((w * 4 + 1) * h);
  for (let y = 0; y < h; y++) {
    raw[y * (w * 4 + 1)] = 0;
    rgba.copy(raw, y * (w * 4 + 1) + 1, y * w * 4, (y + 1) * w * 4);
  }
  const idat = zlib.deflateSync(raw, { level: 9 });
  return Buffer.concat([sig, chunk('IHDR', ihdr), chunk('IDAT', idat), chunk('IEND', Buffer.alloc(0))]);
}

// ---------- drawing ----------
const S = 512;
const img = Buffer.alloc(S * S * 4); // transparent

function blend(x, y, r, g, b, a) {
  if (a <= 0) return;
  const i = (y * S + x) * 4;
  const na = a + (img[i + 3] / 255) * (1 - a);
  if (na <= 0) return;
  img[i] = Math.round((r * a + img[i] * (img[i + 3] / 255) * (1 - a)) / na);
  img[i + 1] = Math.round((g * a + img[i + 1] * (img[i + 3] / 255) * (1 - a)) / na);
  img[i + 2] = Math.round((b * a + img[i + 2] * (img[i + 3] / 255) * (1 - a)) / na);
  img[i + 3] = Math.round(na * 255);
}
function sdRoundRect(px, py, cx, cy, hw, hh, rad) {
  const dx = Math.abs(px - cx) - (hw - rad);
  const dy = Math.abs(py - cy) - (hh - rad);
  const ox = Math.max(dx, 0), oy = Math.max(dy, 0);
  return Math.hypot(ox, oy) + Math.min(Math.max(dx, dy), 0) - rad;
}
function cov(sd) { return Math.min(1, Math.max(0, 0.5 - sd)); }
function inPoly(px, py, poly) {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i], [xj, yj] = poly[j];
    if (yi > py !== yj > py && px < ((xj - xi) * (py - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}
function polyCov(px, py, poly) {
  // 4x4 supersample for smooth edges
  let hit = 0;
  for (let sy = 0; sy < 4; sy++)
    for (let sx = 0; sx < 4; sx++)
      if (inPoly(px + (sx + 0.5) / 4 - 0.5, py + (sy + 0.5) / 4 - 0.5, poly)) hit++;
  return hit / 16;
}

const A = [124, 92, 255];  // #7C5CFF
const B = [34, 211, 238];  // #22D3EE
const INK = [16, 18, 38];  // #101226

const bolt = [
  [283, 128], [194, 268], [246, 268], [222, 352], [318, 206], [262, 206], [296, 128],
];
const tail = [[178, 348], [244, 352], [158, 420]];

for (let y = 0; y < S; y++) {
  for (let x = 0; x < S; x++) {
    // background rounded square with diagonal gradient
    const bg = cov(sdRoundRect(x + 0.5, y + 0.5, 256, 256, 244, 244, 116));
    if (bg > 0) {
      const t = (x + y) / (2 * S);
      blend(x, y, A[0] + (B[0] - A[0]) * t, A[1] + (B[1] - A[1]) * t, A[2] + (B[2] - A[2]) * t, bg);
    }
    // chat bubble (white) + tail
    const bubble = Math.max(cov(sdRoundRect(x + 0.5, y + 0.5, 256, 240, 152, 120, 66)), polyCov(x, y, tail));
    if (bubble > 0) blend(x, y, 255, 255, 255, bubble * 0.97);
    // lightning bolt
    const bc = polyCov(x, y, bolt);
    if (bc > 0) blend(x, y, INK[0], INK[1], INK[2], bc);
  }
}

// ---------- resize (area average) ----------
function resize(n) {
  const out = Buffer.alloc(n * n * 4);
  const f = S / n;
  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n; x++) {
      const x0 = Math.floor(x * f), x1 = Math.ceil((x + 1) * f);
      const y0 = Math.floor(y * f), y1 = Math.ceil((y + 1) * f);
      let r = 0, g = 0, b = 0, a = 0, cnt = 0;
      for (let sy = y0; sy < y1; sy++)
        for (let sx = x0; sx < x1; sx++) {
          const i = (sy * S + sx) * 4;
          const al = img[i + 3] / 255;
          r += img[i] * al; g += img[i + 1] * al; b += img[i + 2] * al; a += al; cnt++;
        }
      const o = (y * n + x) * 4;
      if (a > 0) {
        out[o] = Math.round(r / a); out[o + 1] = Math.round(g / a); out[o + 2] = Math.round(b / a);
      }
      out[o + 3] = Math.round((a / cnt) * 255);
    }
  }
  return out;
}

// ---------- ICO (PNG-compressed entries) ----------
const sizes = [16, 24, 32, 48, 64, 128, 256];
const pngs = sizes.map((n) => encodePNG(n, n, resize(n)));
const header = Buffer.alloc(6);
header.writeUInt16LE(1, 2); // type: icon
header.writeUInt16LE(sizes.length, 4);
let offset = 6 + sizes.length * 16;
const entries = [];
sizes.forEach((n, i) => {
  const e = Buffer.alloc(16);
  e[0] = n === 256 ? 0 : n;
  e[1] = n === 256 ? 0 : n;
  e[4] = 1; // planes
  e[6] = 32; // bpp
  e.writeUInt32LE(pngs[i].length, 8);
  e.writeUInt32LE(offset, 12);
  offset += pngs[i].length;
  entries.push(e);
});

const buildDir = path.join(__dirname, '..', 'build');
fs.mkdirSync(buildDir, { recursive: true });
fs.writeFileSync(path.join(buildDir, 'icon.ico'), Buffer.concat([header, ...entries, ...pngs]));
fs.writeFileSync(path.join(buildDir, 'icon.png'), encodePNG(256, 256, resize(256)));
console.log('icon.ico + icon.png written to build/');
