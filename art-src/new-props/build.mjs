// Builds public/props/image-art.js from the PNG sheets in this folder (white background, isometric art).
// Each sheet goes through scripts/img2sprite.mjs (downscale + palette letters); any near-white colour left in a
// palette becomes '.' (transparent). Run from the repo root: node art-src/new-props/build.mjs
import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '../..');

// height: art px of the tallest frame. kind: 'floor' (cell centre = middle of the base diamond) or 'nook'
// (anchor = the wall cell's centre; the lowest pixel lands on the bottom tip of the floor cell in front).
const SHEETS = [
  { id: 'ore', file: 'minerals/Isometric 8-bit ore prop sprite sheet.png', height: 22, variants: true },
  { id: 'statue', file: 'statue/Two-view pixel dungeon statue sprite sheet.png', height: 50, variants: true },
  { id: 'candle_table', file: 'table-with-candles/Isometric wooden altar with five candles.png', height: 40, outline: false, pick: 0, candles: true },
  { id: 'candle_nook', file: 'wall-candle-nook/Twin towering arches over candlelit tables.png', height: 50, pick: 0, candles: true, nook: true },
];

const hexRgb = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
const isWhite = ([r, g, b]) => Math.min(r, g, b) >= 235 && Math.max(r, g, b) - Math.min(r, g, b) <= 18;
const isFlame = ([r, g, b]) => r >= 200 && g >= 100 && r - b >= 60; // flames, wax and the candle-lit brick glow

function convert(s) {
  const args = [join(root, 'scripts/img2sprite.mjs'), join(here, s.file), '--sheet', '--height', String(s.height), '--name', s.id, '--json'];
  if (s.outline === false) args.push('--no-outline');
  const j = JSON.parse(execFileSync('node', args, { encoding: 'utf8', maxBuffer: 1 << 26 }));
  const white = new Set(Object.entries(j.palette).filter(([, h]) => isWhite(hexRgb(h))).map(([c]) => c));
  const palette = Object.fromEntries(Object.entries(j.palette).filter(([c]) => !white.has(c)));
  const frames = Object.values(j.animations).flat().map((f) => crop(f.map((row) => [...row].map((c) => (white.has(c) ? '.' : c)).join(''))));
  return { palette, frames };
}

// Trim empty rows and columns.
function crop(rows) {
  const on = (r, x) => r[x] && r[x] !== '.';
  const ys = rows.map((r, y) => ([...r].some((c) => c !== '.') ? y : -1)).filter((y) => y >= 0);
  const xs = [];
  for (let x = 0; x < Math.max(...rows.map((r) => r.length)); x++) if (rows.some((r) => on(r, x))) xs.push(x);
  const [x0, x1] = [xs[0], xs.at(-1)];
  return rows.slice(ys[0], ys.at(-1) + 1).map((r) => r.padEnd(x1 + 1, '.').slice(x0, x1 + 1));
}

// Floor prop: the cell centre sits over the middle of the art, a quarter of its width above the lowest pixel (the
// front tip of the base diamond).
function floorAnchor(rows) {
  const h = rows.length, w = rows[0].length;
  return { anchorX: Math.round((w - 1) / 2), anchorY: h - 1 - Math.round(w / 4) };
}

// Nook (face L, flip:false): the wall cell's centre is 16 px right of and 16 px above the lowest pixel (the bottom
// tip of the floor cell in front of the face). The renderer mirrors around anchorX for face R.
function nookAnchor(rows) {
  const h = rows.length, last = rows[h - 1], xs = [...last].map((c, x) => (c !== '.' ? x : -1)).filter((x) => x >= 0);
  const xb = Math.round((xs[0] + xs.at(-1)) / 2);
  return { anchorX: xb + 16, anchorY: h - 1 - 16 };
}

const glowOf = (rows, palette) => {
  const flame = new Set(Object.entries(palette).filter(([, hx]) => isFlame(hexRgb(hx))).map(([c]) => c));
  let sx = 0, sy = 0, n = 0;
  rows.forEach((r, y) => [...r].forEach((c, x) => { if (flame.has(c)) { sx += x; sy += y; n++; } }));
  return { emissive: [...flame], glow: n ? { x: Math.round(sx / n), y: Math.round(sy / n), radius: 14, color: '#ffb458' } : null };
};

const out = {};
for (const s of SHEETS) {
  const { palette, frames } = convert(s);
  const make = (rows) => {
    const def = { palette, frames: [rows], ...(s.nook ? nookAnchor(rows) : floorAnchor(rows)), emissive: [] };
    if (s.candles) {
      const g = glowOf(rows, palette);
      def.emissive = g.emissive;
      if (g.glow) def.glow = g.glow;
    }
    return def;
  };
  out[s.id] = s.variants ? { variants: frames.map(make) } : make(frames[s.pick ?? 0]);
  console.log(s.id, s.variants ? `${frames.length} variants` : '1 view', frames.map((f) => `${f[0].length}x${f.length}`).join(' '));
}

const lit = (v, ind = '') => {
  if (Array.isArray(v) && v.every((x) => typeof x === 'string')) return `[\n${v.map((r) => `${ind}  '${r}',`).join('\n')}\n${ind}]`;
  if (Array.isArray(v)) return `[\n${v.map((x) => `${ind}  ${lit(x, ind + '  ')},`).join('\n')}\n${ind}]`;
  if (v && typeof v === 'object') return `{\n${Object.entries(v).map(([k, x]) => `${ind}  ${/^[a-z_]\w*$/i.test(k) ? k : `'${k}'`}: ${lit(x, ind + '  ')},`).join('\n')}\n${ind}}`;
  return JSON.stringify(v).replace(/"/g, "'");
};

const src = `// Image props: isometric art converted from the PNG sheets in art-src/new-props/ (white background made
// transparent). Generated by \`node art-src/new-props/build.mjs\`: edit the sheets or that script, not this file.
// Same format as floor-art.js. An entry with \`variants\` is one prop kind with several looks; the renderer picks
// one per cell with a hash (visual only). candle_nook is wall decor already drawn in iso: anchor = the wall
// cell's centre, art for face L (the renderer mirrors it for face R).

export const IMAGE_ART = ${lit(out)};
`;
writeFileSync(join(root, 'public/props/image-art.js'), src);
console.log('wrote public/props/image-art.js', `${Math.round(src.length / 1024)} KB`);
