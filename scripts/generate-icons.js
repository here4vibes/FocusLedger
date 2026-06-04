#!/usr/bin/env node
/**
 * Generate FocusLedger PWA icons as PNG files using only Node built-ins.
 * Produces: public/icons/icon-192.png, public/icons/icon-512.png
 * Design: navy background (#1A1A2E) with orange diamond (#F26B3A) — matches the .logo-dot in CSS
 */

const zlib = require('zlib');
const fs = require('fs');
const path = require('path');

// CRC32 for PNG chunks
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
    t[i] = c;
  }
  return t;
})();

function crc32(buf) {
  let crc = 0xFFFFFFFF;
  for (let i = 0; i < buf.length; i++) crc = CRC_TABLE[(crc ^ buf[i]) & 0xFF] ^ (crc >>> 8);
  return (crc ^ 0xFFFFFFFF) >>> 0;
}

function makeChunk(type, data) {
  const typeBuf = Buffer.from(type, 'ascii');
  const lenBuf = Buffer.alloc(4);
  lenBuf.writeUInt32BE(data.length, 0);
  const crcInput = Buffer.concat([typeBuf, data]);
  const crcBuf = Buffer.alloc(4);
  crcBuf.writeUInt32BE(crc32(crcInput), 0);
  return Buffer.concat([lenBuf, typeBuf, data, crcBuf]);
}

/**
 * Generate a PNG icon with:
 * - Navy background
 * - Orange outer diamond
 * - Navy inner diamond (cutout)
 * - Small orange square at exact center (3x3 pixels, scaled)
 */
function makeIcon(size) {
  const cx = size / 2;
  const cy = size / 2;
  const outerRadius = Math.floor(size * 0.38);
  const innerRadius = Math.floor(size * 0.14);
  const dotRadius = Math.floor(size * 0.055);

  // Navy bg: #1A1A2E
  const BG_R = 0x1A, BG_G = 0x1A, BG_B = 0x2E;
  // Orange: #F26B3A
  const OR_R = 0xF2, OR_G = 0x6B, OR_B = 0x3A;
  // Cream center dot: #FFF8F0
  const CR_R = 0xFF, CR_G = 0xF8, CR_B = 0xF0;

  // Raw RGBA data (each row: filter_byte + 4 bytes per pixel)
  const rowBytes = 1 + size * 4;
  const rawData = Buffer.alloc(size * rowBytes, 0);

  for (let y = 0; y < size; y++) {
    const rowStart = y * rowBytes;
    rawData[rowStart] = 0; // filter: None

    for (let x = 0; x < size; x++) {
      const dx = Math.abs(x - cx + 0.5);
      const dy = Math.abs(y - cy + 0.5);
      const manhattan = dx + dy;
      const off = rowStart + 1 + x * 4;

      let r = BG_R, g = BG_G, b = BG_B, a = 255;

      if (manhattan <= outerRadius) {
        // Orange diamond
        r = OR_R; g = OR_G; b = OR_B;
      }
      if (manhattan <= innerRadius) {
        // Navy cutout
        r = BG_R; g = BG_G; b = BG_B;
      }
      if (manhattan <= dotRadius) {
        // Cream center dot
        r = CR_R; g = CR_G; b = CR_B;
      }

      rawData[off] = r;
      rawData[off + 1] = g;
      rawData[off + 2] = b;
      rawData[off + 3] = a;
    }
  }

  // Compress
  const compressed = zlib.deflateSync(rawData, { level: 9 });

  // IHDR: width, height, bitDepth=8, colorType=6(RGBA), compress=0, filter=0, interlace=0
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;   // bit depth
  ihdr[9] = 6;   // RGBA
  ihdr[10] = 0;  // compression
  ihdr[11] = 0;  // filter
  ihdr[12] = 0;  // interlace

  const PNG_SIG = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

  return Buffer.concat([
    PNG_SIG,
    makeChunk('IHDR', ihdr),
    makeChunk('IDAT', compressed),
    makeChunk('IEND', Buffer.alloc(0))
  ]);
}

const iconsDir = path.join(__dirname, '..', 'public', 'icons');
if (!fs.existsSync(iconsDir)) fs.mkdirSync(iconsDir, { recursive: true });

[192, 512].forEach(size => {
  const png = makeIcon(size);
  const outPath = path.join(iconsDir, `icon-${size}.png`);
  fs.writeFileSync(outPath, png);
  console.log(`Generated ${outPath} (${png.length} bytes)`);
});

console.log('Icons generated successfully.');
