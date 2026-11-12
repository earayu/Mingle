// Draws the app icon and the menu bar icon as PNGs, with no dependencies.
// The mark is two interlocking rings: two parties meeting. Run: node desktop/scripts/icons.mjs
import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { deflateSync } from "node:zlib";

const out = join(dirname(fileURLToPath(import.meta.url)), "..", "resources");

function png(size, pixel) {
  const raw = Buffer.alloc(size * (size * 4 + 1));
  const ss = 4; // 4×4 samples per pixel for smooth edges
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0;
    for (let x = 0; x < size; x++) {
      let r = 0,
        g = 0,
        b = 0,
        a = 0;
      for (let sy = 0; sy < ss; sy++) {
        for (let sx = 0; sx < ss; sx++) {
          const [pr, pg, pb, pa] = pixel((x + (sx + 0.5) / ss) / size, (y + (sy + 0.5) / ss) / size);
          r += pr * pa;
          g += pg * pa;
          b += pb * pa;
          a += pa;
        }
      }
      const o = y * (size * 4 + 1) + 1 + x * 4;
      const n = ss * ss;
      raw[o] = a ? Math.round(r / a) : 0;
      raw[o + 1] = a ? Math.round(g / a) : 0;
      raw[o + 2] = a ? Math.round(b / a) : 0;
      raw[o + 3] = Math.round((a / n) * 255);
    }
  }
  const chunk = (type, data) => {
    const length = Buffer.alloc(4);
    length.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(body));
    return Buffer.concat([length, body, crc]);
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0);
  header.writeUInt32BE(size, 4);
  header[8] = 8; // bit depth
  header[9] = 6; // RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", header),
    chunk("IDAT", deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

const table = new Uint32Array(256).map((_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c;
});
function crc32(buf) {
  let c = 0xffffffff;
  for (const byte of buf) c = table[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/** Two rings of radius r and stroke w, centred left and right of (cx, cy). */
function rings(x, y, { cx, cy, r, w, gap }) {
  const d1 = Math.abs(Math.hypot(x - (cx - gap), y - cy) - r);
  const d2 = Math.abs(Math.hypot(x - (cx + gap), y - cy) - r);
  return d1 < w / 2 || d2 < w / 2;
}

function roundedSquare(x, y, inset, radius) {
  const lo = inset;
  const hi = 1 - inset;
  if (x < lo || x > hi || y < lo || y > hi) return false;
  const qx = Math.max(lo + radius - x, x - (hi - radius), 0);
  const qy = Math.max(lo + radius - y, y - (hi - radius), 0);
  return Math.hypot(qx, qy) <= radius;
}

// App icon: the macOS grid leaves about 10% around the rounded square.
const ink = [0x1a, 0x1a, 0x1a];
const paper = [0xff, 0xff, 0xff];
writeFileSync(
  join(out, "icon.png"),
  png(1024, (x, y) => {
    if (!roundedSquare(x, y, 0.1, 0.18)) return [0, 0, 0, 0];
    return rings(x, y, { cx: 0.5, cy: 0.5, r: 0.17, w: 0.055, gap: 0.095 }) ? [...paper, 1] : [...ink, 1];
  }),
);

// Menu bar icon: a template image, black on transparent, 16 pt at 2x.
writeFileSync(
  join(out, "tray.png"),
  png(32, (x, y) => (rings(x, y, { cx: 0.5, cy: 0.5, r: 0.27, w: 0.09, gap: 0.17 }) ? [0, 0, 0, 1] : [0, 0, 0, 0])),
);
console.log(`icons written to ${out}`);
