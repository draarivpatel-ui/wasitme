// PNG helpers for the screenshot comparison: decoding reuses the design system's zero-dependency decoder; encoding
// is a minimal RGBA writer (node:zlib only). Used to put a design screen and the canvas side by side and to measure
// how many pixels differ.
import { deflateSync } from "node:zlib";
export { decodePng } from "../../design/system/gen/png.mjs";

const CRC = (() => { const t = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
function crc32(buf) { let c = 0xffffffff; for (const b of buf) c = CRC[(c ^ b) & 255] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; }
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}

/** { width, height, data: RGBA Buffer } → PNG bytes. */
export function encodePng({ width, height, data }) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4); ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  const raw = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y++) { raw[y * (width * 4 + 1)] = 0; data.copy(raw, y * (width * 4 + 1) + 1, y * width * 4, (y + 1) * width * 4); }
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", ihdr), chunk("IDAT", deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]);
}

/** Two images side by side (top-aligned), with a 16 px gutter. */
export function sideBySide(a, b) {
  const g = 16, width = a.width + g + b.width, height = Math.max(a.height, b.height);
  const data = Buffer.alloc(width * height * 4, 255);
  const blit = (img, ox) => { for (let y = 0; y < img.height; y++) img.data.copy(data, (y * width + ox) * 4, y * img.width * 4, (y + 1) * img.width * 4); };
  blit(a, 0); blit(b, a.width + g);
  return { width, height, data };
}

/** Share of pixels whose largest channel difference exceeds `tol` (same size only). */
export function diffShare(a, b, tol = 24) {
  if (a.width !== b.width || a.height !== b.height) return null;
  let n = 0;
  for (let i = 0; i < a.data.length; i += 4) {
    const d = Math.max(Math.abs(a.data[i] - b.data[i]), Math.abs(a.data[i + 1] - b.data[i + 1]), Math.abs(a.data[i + 2] - b.data[i + 2]));
    if (d > tol) n++;
  }
  return n / (a.width * a.height);
}
