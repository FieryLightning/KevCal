// Generates the home-screen icons. A web app you add to your phone gets judged
// by its icon before anything else, and a screenshot-of-a-webpage icon reads as
// "unfinished", so this draws a real one: a rounded violet tile with a white
// calendar on it. Pure pixel maths and node:zlib — nothing to install.
//
// Run: npm run icons

import zlib from 'node:zlib';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const OUT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');

const lerp = (a, b, t) => a + (b - a) * t;
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

/** Signed distance to a rounded rectangle, for cheap anti-aliasing. */
function roundRectSDF(px, py, cx, cy, halfW, halfH, r) {
  const dx = Math.abs(px - cx) - (halfW - r);
  const dy = Math.abs(py - cy) - (halfH - r);
  const ax = Math.max(dx, 0), ay = Math.max(dy, 0);
  return Math.sqrt(ax * ax + ay * ay) + Math.min(Math.max(dx, dy), 0) - r;
}

function coverage(sdf) { return clamp(0.5 - sdf, 0, 1); }

function over(dst, src, alpha) {
  return [
    lerp(dst[0], src[0], alpha),
    lerp(dst[1], src[1], alpha),
    lerp(dst[2], src[2], alpha),
  ];
}

function render(size) {
  const S = size;
  const px = Buffer.alloc(S * S * 4);
  const u = S / 512;                       // everything below is drawn at 512

  for (let y = 0; y < S; y++) {
    for (let x = 0; x < S; x++) {
      const X = x / u, Y = y / u;

      // Tile: violet to magenta on the diagonal.
      const t = clamp((X + Y) / 1024, 0, 1);
      let rgb = [lerp(99, 190, t), lerp(78, 74, t), lerp(252, 246, t)];
      let alpha = coverage(roundRectSDF(X, Y, 256, 256, 256, 256, 114) * u) ;

      // Calendar body.
      const body = coverage(roundRectSDF(X, Y, 256, 272, 150, 132, 30));
      rgb = over(rgb, [255, 255, 255], body * 0.97);

      // Header band, slightly tinted so the card reads as a calendar not a box.
      if (Y < 190) {
        const band = coverage(roundRectSDF(X, Y, 256, 272, 150, 132, 30))
                   * coverage(roundRectSDF(X, Y, 256, 150, 150, 44, 24));
        rgb = over(rgb, [237, 233, 254], band);
      }

      // Two binding tabs above the card.
      for (const cx of [196, 316]) {
        const tab = coverage(roundRectSDF(X, Y, cx, 128, 17, 40, 17));
        rgb = over(rgb, [255, 255, 255], tab);
      }

      // Date grid: three rows of dots, with one highlighted the accent colour.
      for (let row = 0; row < 3; row++) {
        for (let col = 0; col < 4; col++) {
          const cx = 172 + col * 56;
          const cy = 236 + row * 56;
          const dot = coverage(roundRectSDF(X, Y, cx, cy, 15, 15, 15));
          const isMarked = row === 1 && col === 2;
          rgb = over(rgb, isMarked ? [124, 58, 237] : [203, 199, 218], dot * (isMarked ? 1 : 0.85));
        }
      }

      const i = (y * S + x) * 4;
      px[i] = Math.round(rgb[0]);
      px[i + 1] = Math.round(rgb[1]);
      px[i + 2] = Math.round(rgb[2]);
      px[i + 3] = Math.round(alpha * 255);
    }
  }
  return px;
}

function crc32(buf) {
  let c, crc = 0xffffffff;
  for (let n = 0; n < buf.length; n++) {
    c = (crc ^ buf[n]) & 0xff;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    crc = c ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

function png(size, rgba) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;    // bit depth
  ihdr[9] = 6;    // truecolour with alpha
  const raw = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0;  // filter: none
    rgba.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

for (const [name, size] of [['icon-512.png', 512], ['icon-192.png', 192], ['apple-touch-icon.png', 180]]) {
  fs.writeFileSync(path.join(OUT, name), png(size, render(size)));
  console.log(`  ${name}  ${size}×${size}`);
}
