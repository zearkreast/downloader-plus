// The extension's toolbar icons.
//
// The application's own mark, not a relative of it: an eight-blade aperture
// with a plus in its opening, on nothing, in the same proportions
// scripts/generate_icon.py draws it in, so a user looking at the toolbar can tell
// which program the button belongs to.
//
// The PNG encoder is here rather than from a package because the repository has
// no image library on the JavaScript side and four small icons are not worth
// adding one; node:zlib already does the only hard part.
//
// Run:  node extension/make-icons.mjs

import { deflateSync } from 'node:zlib';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const outDir = join(dirname(fileURLToPath(import.meta.url)), 'icons');
const SIZES = [16, 32, 48, 128];

// Supersampled and box-filtered afterwards; a disc and its diagonal seams drawn
// by testing pixel centres have visibly ragged edges at 16px otherwise. Eight
// rather than four because the seams are the whole point of the mark and a
// coarse grid quantises their width into a stair.
const SAMPLES = 8;

const BLADES = 8;
// All as fractions of the disc's diameter, matching generate_icon.py.
const MARK_FILL = 0.94;
const INNER_R = 0.3;
const SEAM_W = 0.058;
const PLUS_SPAN = 0.3;
const PLUS_W = 0.1;

const EMBER = [255, 78, 44];
const AMBER = [255, 168, 56];

const STEP = (2 * Math.PI) / BLADES;
// A flat edge of the opening faces up, so the plus sits square inside it.
const FIRST = -Math.PI / 2 + STEP;
const LIGHT = (-125 * Math.PI) / 180;

const mix = (t) => EMBER.map((value, i) => value + (AMBER[i] - value) * t);
const clamp = (t) => Math.max(0, Math.min(1, t));

function toRim(x, y, ux, uy, radius) {
  const b = x * ux + y * uy;
  const t = -b + Math.sqrt(b * b - x * x - y * y + radius * radius);
  return [x + ux * t, y + uy * t];
}

// Built once per size rather than per sub-sample: the blades do not depend on
// the point being tested, and at 128px with eight samples the point being
// tested comes round a million times.
function markSampler(size) {
  const centre = size / 2;
  const diameter = size * MARK_FILL;
  const radius = diameter / 2;
  const apothem = diameter * INNER_R * Math.cos(STEP / 2);
  const halfSeam = (diameter * SEAM_W) / 2;
  const plusHalf = (diameter * PLUS_SPAN) / 2;
  const plusArm = (diameter * PLUS_W) / 2;
  const plusCorner = plusArm * 0.42;

  // A blade is what lies between two neighbouring edges of the opening, each
  // carried on past its corner, once half a seam is kept from both.
  const blades = Array.from({ length: BLADES }, (_, i) => {
    const angle = (k) => FIRST + k * STEP;
    const [n1x, n1y] = [Math.cos(angle(i)), Math.sin(angle(i))];
    const [n2x, n2y] = [Math.cos(angle(i + 1)), Math.sin(angle(i + 1))];
    const c1 = apothem - halfSeam;
    const c2 = apothem + halfSeam;
    const det = n1x * n2y - n1y * n2x;
    const tipX = (c1 * n2y - c2 * n1y) / det;
    const tipY = (n1x * c2 - n2x * c1) / det;

    const near = toRim(tipX, tipY, -n1y, n1x, radius);
    const far = toRim(tipX, tipY, -n2y, n2x, radius);
    const middle = Math.atan2(near[1] + far[1], near[0] + far[0]);
    const dx = radius * Math.cos(middle) - tipX;
    const dy = radius * Math.sin(middle) - tipY;
    const lit = 0.5 + 0.5 * Math.cos(middle - LIGHT);
    return {
      n1x, n1y, n2x, n2y, c1, c2, tipX, tipY, dx, dy,
      length: dx * dx + dy * dy,
      start: mix(lit * 0.35),
      stop: mix(0.35 + lit * 0.65),
    };
  });

  const inArm = (a, b) => {
    if (Math.abs(a) > plusHalf || Math.abs(b) > plusArm) return false;
    const over = Math.abs(a) - (plusHalf - plusCorner);
    const side = Math.abs(b) - (plusArm - plusCorner);
    return over <= 0 || side <= 0 || over * over + side * side <= plusCorner * plusCorner;
  };

  return (x, y) => {
    const px = x - centre;
    const py = y - centre;

    if (inArm(px, py) || inArm(py, px)) {
      return mix(1 - clamp(((px + py) / plusHalf + 2) / 4));
    }
    if (px * px + py * py > radius * radius) return null;

    for (const blade of blades) {
      if (px * blade.n1x + py * blade.n1y > blade.c1) continue;
      if (px * blade.n2x + py * blade.n2y < blade.c2) continue;
      const t = clamp(((px - blade.tipX) * blade.dx + (py - blade.tipY) * blade.dy) / blade.length);
      return blade.start.map((value, i) => value + (blade.stop[i] - value) * t);
    }
    return null;
  };
}

function render(size) {
  const pixels = Buffer.alloc(size * size * 4);
  const step = 1 / SAMPLES;
  const sample = markSampler(size);

  for (let py = 0; py < size; py += 1) {
    for (let px = 0; px < size; px += 1) {
      let r = 0;
      let g = 0;
      let b = 0;
      let covered = 0;

      for (let sy = 0; sy < SAMPLES; sy += 1) {
        for (let sx = 0; sx < SAMPLES; sx += 1) {
          const colour = sample(px + (sx + 0.5) * step, py + (sy + 0.5) * step);
          if (!colour) continue;
          r += colour[0];
          g += colour[1];
          b += colour[2];
          covered += 1;
        }
      }

      const offset = (py * size + px) * 4;
      const total = SAMPLES * SAMPLES;
      if (covered === 0) continue;
      // Averaged over the covered samples, not over all of them: dividing by
      // the full count would darken every edge pixel towards black instead of
      // fading it towards transparent.
      pixels[offset] = Math.round(r / covered);
      pixels[offset + 1] = Math.round(g / covered);
      pixels[offset + 2] = Math.round(b / covered);
      pixels[offset + 3] = Math.round((covered / total) * 255);
    }
  }

  return pixels;
}

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

function crc32(buffer) {
  let c = 0xffffffff;
  for (const byte of buffer) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, crc]);
}

function png(size, pixels) {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0);
  header.writeUInt32BE(size, 4);
  header[8] = 8; // bit depth
  header[9] = 6; // truecolour with alpha
  // Compression 0, filter 0, interlace 0 are the only values PNG defines.

  const raw = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y += 1) {
    const line = y * (size * 4 + 1);
    raw[line] = 0; // no per-scanline filter; these images are tiny
    pixels.copy(raw, line + 1, y * size * 4, (y + 1) * size * 4);
  }

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

mkdirSync(outDir, { recursive: true });
for (const size of SIZES) {
  const path = join(outDir, `icon${size}.png`);
  writeFileSync(path, png(size, render(size)));
  console.log(`make-icons: wrote ${path}`);
}
