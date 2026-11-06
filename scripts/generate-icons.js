#!/usr/bin/env node
/*
 * Generates the placeholder icons (icons/icon16.png, icon48.png, icon128.png):
 * a purple rounded square with a white funnel. No dependencies - it rasterises
 * with 4x4 supersampling and writes PNGs using only node:zlib and node:fs.
 *
 *   node scripts/generate-icons.js
 */
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');

const SIZES = [16, 48, 128];
const BACKGROUND = [0x82, 0x50, 0xdf]; // purple
const FOREGROUND = [0xff, 0xff, 0xff];
const SAMPLES = 4; // per axis

// Funnel outline in unit coordinates (0..1, y down).
const FUNNEL = [
  [0.2, 0.25],
  [0.8, 0.25],
  [0.58, 0.51],
  [0.58, 0.8],
  [0.42, 0.7],
  [0.42, 0.51],
];

function inPolygon(x, y, poly) {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i];
    const [xj, yj] = poly[j];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

function inRoundedSquare(x, y, radius) {
  const half = 0.5 - radius;
  const dx = Math.max(Math.abs(x - 0.5) - half, 0);
  const dy = Math.max(Math.abs(y - 0.5) - half, 0);
  return dx * dx + dy * dy <= radius * radius;
}

/** Returns RGBA bytes for a size x size icon. */
function render(size) {
  const out = Buffer.alloc(size * size * 4);
  const total = SAMPLES * SAMPLES;
  for (let py = 0; py < size; py++) {
    for (let px = 0; px < size; px++) {
      let bg = 0;
      let fg = 0;
      for (let sy = 0; sy < SAMPLES; sy++) {
        for (let sx = 0; sx < SAMPLES; sx++) {
          const x = (px + (sx + 0.5) / SAMPLES) / size;
          const y = (py + (sy + 0.5) / SAMPLES) / size;
          if (!inRoundedSquare(x, y, 0.22)) continue;
          bg++;
          if (inPolygon(x, y, FUNNEL)) fg++;
        }
      }
      const i = (py * size + px) * 4;
      if (bg === 0) continue; // fully transparent
      const mix = fg / bg; // share of covered samples that are funnel
      for (let c = 0; c < 3; c++) out[i + c] = Math.round(BACKGROUND[c] * (1 - mix) + FOREGROUND[c] * mix);
      out[i + 3] = Math.round((bg / total) * 255); // edge anti-aliasing
    }
  }
  return out;
}

// --- minimal PNG encoder -----------------------------------------------------
const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

function crc32(buf) {
  let c = 0xffffffff;
  for (const byte of buf) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

function encodePng(size, rgba) {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0);
  header.writeUInt32BE(size, 4);
  header[8] = 8; // bit depth
  header[9] = 6; // colour type: RGBA
  const stride = size * 4;
  const raw = Buffer.alloc((stride + 1) * size); // each scanline: filter byte 0 + pixels
  for (let y = 0; y < size; y++) rgba.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

const dir = path.join(__dirname, '..', 'icons');
fs.mkdirSync(dir, { recursive: true });
for (const size of SIZES) {
  const file = path.join(dir, `icon${size}.png`);
  fs.writeFileSync(file, encodePng(size, render(size)));
  console.log(`wrote ${path.relative(process.cwd(), file)}`);
}
