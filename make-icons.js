// Generate simple PNG icons for the extension without external dependencies.
// Produces icons/icon16.png, icon48.png, icon128.png.
// Run: node make-icons.js
import zlib from "node:zlib";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ICON_DIR = join(HERE, "icons");

// Encode a single RGBA PNG of the given size. Draws a rounded-ish blue background
// with a lighter "S"-ish diagonal mark. Purely decorative so the extension loads
// without Chrome icon warnings.
function encodePng(size) {
  const bg = [0x4a, 0xa3, 0xff, 0xff]; // accent blue
  const fg = [0xff, 0xff, 0xff, 0xff]; // white

  const pixels = Buffer.alloc(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = (y * size + x) * 4;
      // Draw an "S" shape as a simple thickness-based test.
      const cx = size / 2;
      const cy = size / 2;
      const dx = (x - cx) / (size / 2);
      const dy = (y - cy) / (size / 2);
      const color = inS(dx, dy) ? fg : bg;
      pixels[i] = color[0];
      pixels[i + 1] = color[1];
      pixels[i + 2] = color[2];
      pixels[i + 3] = color[3];
    }
  }

  return buildPng(pixels, size, size);
}

// Rough "S" coverage test in normalized [-1,1] coordinates.
function inS(dx, dy) {
  const thickness = 0.28;
  // Top bar
  if (dy < -0.4 && Math.abs(dx) < 0.6) return true;
  // Middle bar
  if (Math.abs(dy) < 0.1 && Math.abs(dx) < 0.6) return true;
  // Bottom bar
  if (dy > 0.4 && Math.abs(dx) < 0.6) return true;
  // Left side connecting top to middle
  if (dy >= -0.4 && dy <= 0.1 && Math.abs(dx + 0.46) < thickness) return true;
  // Right side connecting middle to bottom
  if (dy >= -0.1 && dy <= 0.4 && Math.abs(dx - 0.46) < thickness) return true;
  return false;
}

// Build a PNG file from raw RGBA pixels using only zlib. Minimal but spec-compliant.
function buildPng(rgba, width, height) {
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

  // IHDR
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // color type (RGBA)
  ihdr[10] = 0; // compression
  ihdr[11] = 0; // filter
  ihdr[12] = 0; // interlace

  // IDAT: prepend filter byte 0 per scanline.
  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0; // filter: none
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, y * stride + stride);
  }
  const idat = zlib.deflateSync(raw, { level: 9 });

  return Buffer.concat([
    signature,
    chunk("IHDR", ihdr),
    chunk("IDAT", idat),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, "ascii");
  const crc = crc32(Buffer.concat([typeBuf, data]));
  const crcBuf = Buffer.alloc(4);
  crcBuf.writeUInt32BE(crc >>> 0, 0);
  return Buffer.concat([len, typeBuf, data, crcBuf]);
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[n] = c;
  }
  return table;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  }
  return c ^ 0xffffffff;
}

mkdirSync(ICON_DIR, { recursive: true });
for (const size of [16, 48, 128]) {
  writeFileSync(join(ICON_DIR, `icon${size}.png`), encodePng(size));
  console.log(`wrote icons/icon${size}.png`);
}
