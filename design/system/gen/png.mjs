// Minimal PNG decoder (8-bit, non-interlaced, colour types 0/2/4/6). Zero deps: node:zlib only.
// Used by glyph-check.mjs and render.mjs to read headless-Chrome screenshots.
import { inflateSync } from 'node:zlib';
import { readFileSync } from 'node:fs';

export function decodePng(buf) {
  if (typeof buf === 'string') buf = readFileSync(buf);
  let p = 8, w = 0, h = 0, type = 0, depth = 0, interlace = 0;
  const idat = [];
  while (p < buf.length) {
    const len = buf.readUInt32BE(p); const t = buf.toString('ascii', p + 4, p + 8);
    const d = buf.subarray(p + 8, p + 8 + len);
    if (t === 'IHDR') { w = d.readUInt32BE(0); h = d.readUInt32BE(4); depth = d[8]; type = d[9]; interlace = d[12]; }
    else if (t === 'IDAT') idat.push(d);
    else if (t === 'IEND') break;
    p += 12 + len;
  }
  if (depth !== 8 || interlace) throw new Error(`unsupported PNG (depth ${depth}, interlace ${interlace})`);
  const ch = { 0: 1, 2: 3, 4: 2, 6: 4 }[type];
  if (!ch) throw new Error(`unsupported colour type ${type}`);
  const raw = inflateSync(Buffer.concat(idat));
  const stride = w * ch, out = Buffer.alloc(w * h * 4);
  let prev = Buffer.alloc(stride), cur = Buffer.alloc(stride);
  for (let y = 0; y < h; y++) {
    const f = raw[y * (stride + 1)], line = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    for (let x = 0; x < stride; x++) {
      const a = x >= ch ? cur[x - ch] : 0, b = prev[x], c = x >= ch ? prev[x - ch] : 0;
      let v = line[x];
      if (f === 1) v += a; else if (f === 2) v += b; else if (f === 3) v += (a + b) >> 1;
      else if (f === 4) { const pa = Math.abs(b - c), pb = Math.abs(a - c), pc = Math.abs(a + b - 2 * c); v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c; }
      cur[x] = v & 255;
    }
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4, s = x * ch;
      if (ch === 1) out[i] = out[i + 1] = out[i + 2] = cur[s], out[i + 3] = 255;
      else if (ch === 2) out[i] = out[i + 1] = out[i + 2] = cur[s], out[i + 3] = cur[s + 1];
      else { out[i] = cur[s]; out[i + 1] = cur[s + 1]; out[i + 2] = cur[s + 2]; out[i + 3] = ch === 4 ? cur[s + 3] : 255; }
    }
    [prev, cur] = [cur, prev];
  }
  return { width: w, height: h, data: out };
}
