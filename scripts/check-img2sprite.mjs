// Checks for scripts/img2sprite.mjs: every sprite in public/sprites.js is drawn to an image (PNG
// and JPEG, several scales, with and without a background), converted back, and compared with the
// original art by colour. Sprite sheets: the troll's idle + walk frames in an even grid and packed
// between uneven gutters. Plus a fast-check round trip on random art. Free, no Jev, a few seconds.
// Run from the dungeon-game directory: node scripts/check-img2sprite.mjs

import fc from 'fast-check';
import jpeg from 'jpeg-js';
import { ART } from '../public/sprites.js';
import { convert, convertSheet, toLab } from './img2sprite.mjs';

let failures = 0;
const fail = (msg) => {
  failures++;
  if (failures <= 25) console.error('FAIL:', msg);
};
const fromHex = (h) => { const n = parseInt(h.slice(1), 16); return [n >> 16, (n >> 8) & 255, n & 255]; };
const dist = (p, q) => Math.hypot(p[0] - q[0], p[1] - q[1], p[2] - q[2]);
const near = (p, q, tol) => Math.hypot(p[0] - q[0], p[1] - q[1], p[2] - q[2]) <= tol;

// Trims a grid to its opaque cells (the converter crops to the character).
function trim(g) {
  const ys = g.map((r, y) => (/[^.]/.test(r) ? y : -1)).filter((y) => y >= 0);
  const xs = [...g[0]].map((_, x) => (g.some((r) => r[x] !== '.') ? x : -1)).filter((x) => x >= 0);
  return g.slice(ys[0], ys.at(-1) + 1).map((r) => r.slice(xs[0], xs.at(-1) + 1));
}
// Trims several frames by their common box (frames of one animation keep their registration).
function trimAll(frames) {
  const merged = frames[0].map((_, y) => [...frames[0][y]].map((_, x) => (frames.some((f) => f[y][x] !== '.') ? 'x' : '.')).join(''));
  const ys = merged.map((r, y) => (/x/.test(r) ? y : -1)).filter((y) => y >= 0);
  const xs = [...merged[0]].map((_, x) => (merged.some((r) => r[x] !== '.') ? x : -1)).filter((x) => x >= 0);
  return frames.map((f) => f.slice(ys[0], ys.at(-1) + 1).map((r) => r.slice(xs[0], xs.at(-1) + 1)));
}

// Draws frames (grids) into one RGBA image: `place(i)` gives each frame's top-left in art pixels.
function draw(frames, palette, scale, { W, H, place, bg = null }) {
  const data = new Uint8Array(W * H * 4);
  if (bg) for (let i = 0; i < W * H; i++) data.set([...bg, 255], i * 4);
  frames.forEach((g, i) => {
    const [ox, oy] = place(i);
    g.forEach((row, y) => [...row].forEach((ch, x) => {
      if (ch === '.') return;
      const c = fromHex(palette[ch]);
      for (let dy = 0; dy < scale; dy++) for (let dx = 0; dx < scale; dx++) {
        const j = (((oy + y) * scale + dy) * W + (ox + x) * scale + dx) * 4;
        data.set([...c, 255], j);
      }
    }));
  });
  return { width: W, height: H, data, hasAlpha: !bg };
}
const viaJpeg = (img, quality) => {
  const out = jpeg.decode(jpeg.encode(img, quality).data, { useTArray: true, formatAsRGBA: true });
  return { width: out.width, height: out.height, data: out.data, hasAlpha: false };
};

// Share of cells where the converted art matches the original: both transparent, or both opaque
// with colours within tol (8-bit RGB distance). Sizes must match.
function match(orig, origPal, got, gotPal, tol) {
  if (orig.length !== got.length || orig[0].length !== got[0].length) return { share: 0, why: `size ${got[0].length}x${got.length}, want ${orig[0].length}x${orig.length}` };
  let ok = 0, n = 0;
  orig.forEach((row, y) => [...row].forEach((a, x) => {
    const b = got[y][x];
    n++;
    if (a === '.' ? b === '.' : b !== '.' && near(fromHex(origPal[a]), fromHex(gotPal[b]), tol)) ok++;
  }));
  return { share: ok / n, why: `${n - ok} of ${n} cells differ` };
}

// --- 1. every sprite, single image ---------------------------------------------------------------

for (const [name, def] of Object.entries(ART)) {
  const want = trim(def.frames[0]);
  const w = want[0].length, h = want.length;
  for (const scale of [1, 4, 7]) {
    const img = draw([want], def.palette, scale, { W: w * scale, H: h * scale, place: () => [0, 0] });
    const res = await convert(img);
    const m = match(want, def.palette, res.grid, res.palette, 0);
    if (m.share < 1) fail(`${name} PNG ${scale}x: not 1:1 (${m.why}; ${res.report.mode}, scale ${res.report.scale})`);
  }
  // Pasted JPEGs: a white margin around the art, quality 85.
  for (const scale of [4, 8]) {
    const pad = 3;
    const img = draw([want], def.palette, scale, { W: (w + 2 * pad) * scale, H: (h + 2 * pad) * scale, place: () => [pad, pad], bg: [255, 255, 255] });
    const res = await convert(viaJpeg(img, 85));
    const m = match(want, def.palette, res.grid, res.palette, 40);
    if (m.share < 0.97) fail(`${name} JPEG ${scale}x: ${(m.share * 100).toFixed(1)}% of cells match, want >= 97% (${m.why})`);
  }
}

// --- 2. sprite sheets ----------------------------------------------------------------------------

// Two animations of the troll: idle (2 frames) and walk (4 frames), in a 4x2 grid of slots.
const troll = ART.troll;
const anims = [troll.frames, troll.walk];
const all = trimAll([...troll.frames, ...troll.walk]);
const idleWant = all.slice(0, 2), walkWant = all.slice(2);
const fw = troll.frames[0][0].length, fh = troll.frames[0].length;
const sheetFrames = anims.flat();
const slot = (i) => (i < 2 ? [i, 0] : [i - 2, 1]);
for (const [label, scale, viaJ] of [['PNG 1x', 1, false], ['PNG 4x', 4, false], ['JPEG 4x', 4, true]]) {
  const sw = fw + 6, sh = fh + 6;
  let img = draw(sheetFrames, troll.palette, scale, { W: 4 * sw * scale, H: 2 * sh * scale, place: (i) => [slot(i)[0] * sw + 3, slot(i)[1] * sh + 3], bg: viaJ ? [255, 255, 255] : null });
  if (viaJ) img = viaJpeg(img, 90);
  for (const how of [{ sheet: true }, { grid: [4, 2] }]) {
    const res = await convertSheet(img, { ...how, rows: ['idle', 'walk'] });
    const idle = res.groups.find((g) => g.name === 'idle'), walk = res.groups.find((g) => g.name === 'walk');
    const tag = `troll sheet ${label} ${how.grid ? '--grid 4x2' : '--sheet'}`;
    if (idle?.frames.length !== 2 || walk?.frames.length !== 4) { fail(`${tag}: got ${res.groups.map((g) => `${g.name}:${g.frames.length}`).join(' ')}, want idle:2 walk:4`); continue; }
    const tol = viaJ ? 40 : 0, need = viaJ ? 0.97 : 1;
    [...idle.frames, ...walk.frames].forEach((f, i) => {
      const m = match([...idleWant, ...walkWant][i], troll.palette, f, res.palette, tol);
      if (m.share < need) fail(`${tag} frame ${i}: ${(m.share * 100).toFixed(1)}% match (${m.why})`);
    });
  }
}

// Packed between uneven gutters (no even grid): frames come back bottom-centred, same size.
{
  const gaps = [2, 5, 3, 7, 4, 2];
  let x = 1;
  const xsAt = sheetFrames.map((_, i) => { const at = x; x += fw + gaps[i]; return at; });
  const img = draw(sheetFrames, troll.palette, 2, { W: x * 2, H: (fh + 2) * 2, place: (i) => [xsAt[i], 1] });
  const res = await convertSheet(img, { sheet: true });
  if (res.frames.length !== 6) fail(`troll packed sheet: ${res.frames.length} frames, want 6`);
  else if (new Set(res.frames.map((f) => `${f[0].length}x${f.length}`)).size !== 1) fail('troll packed sheet: frames differ in size');
}

// --- 3. random art round trip --------------------------------------------------------------------

// Random art in a random palette at a random scale must come back pixel for pixel: drawn again at
// the detected scale, it equals the source (an art grid that is itself an upscale may come back
// coarser, which draws the same). Two kinds of source: a PNG with a transparent margin, and an
// opaque image on a solid background colour unlike any art colour (exercises the border fill and
// the enclosed pockets).
const colour = fc.tuple(fc.nat(255), fc.nat(255), fc.nat(255));
const toHex = (c) => '#' + c.map((v) => v.toString(16).padStart(2, '0')).join('');
const artArb = fc.record({
  w: fc.integer({ min: 2, max: 16 }),
  h: fc.integer({ min: 2, max: 16 }),
  colours: fc.uniqueArray(colour.map(toHex), { minLength: 1, maxLength: 8 }),
  scale: fc.integer({ min: 1, max: 6 }),
  bg: fc.option(colour, { nil: null }),
}).chain((o) => fc.array(fc.array(fc.nat(o.colours.length), { minLength: o.w, maxLength: o.w }), { minLength: o.h, maxLength: o.h })
  .filter((rows) => rows.some((r) => r.some((v) => v > 0)))
  .map((rows) => ({ ...o, rows })));

try {
  await fc.assert(fc.asyncProperty(artArb, async ({ colours, scale, rows, bg }) => {
    if (bg) fc.pre(colours.every((c) => dist(toLab(...fromHex(c)), toLab(...bg)) > 0.12));
    // The converter treats colours closer than its edge threshold as one colour, by design.
    const labs = colours.map((c) => toLab(...fromHex(c)));
    fc.pre(labs.every((a, i) => labs.every((b, j) => i <= j || dist(a, b) > 0.08)));
    const pal = Object.fromEntries(colours.map((c, i) => [String.fromCharCode(65 + i), c]));
    const grid = trim(rows.map((r) => r.map((v) => (v ? String.fromCharCode(64 + v) : '.')).join('')));
    const w = grid[0].length + 2, h = grid.length + 2;
    const src = draw([grid], pal, scale, { W: w * scale, H: h * scale, place: () => [1, 1], bg });
    const res = await convert(src);
    // Compare at the source's scale: the result redrawn must equal the art trimmed to its pixels.
    const want = draw([grid], pal, scale, { W: grid[0].length * scale, H: grid.length * scale, place: () => [0, 0] });
    const s = want.width / res.grid[0].length;
    if (!Number.isInteger(s) || res.grid.length * s !== want.height) return false;
    const back = draw([res.grid], res.palette, s, { W: want.width, H: want.height, place: () => [0, 0] });
    for (let i = 0; i < want.data.length; i++) if (want.data[i] !== back.data[i]) return false;
    return true;
  }), { numRuns: 300 });
} catch (err) {
  fail(`random art round trip\n${err.message}`);
}

// A character with no margin at all keeps every pixel (nothing to call background).
{
  const res = await convert({ width: 1, height: 2, data: new Uint8Array([0, 0, 14, 255, 0, 0, 0, 255]) });
  if (res.grid.length !== 2) fail(`no-margin image: lost pixels (${res.report.background})`);
}

if (failures) {
  console.error(`\n${failures} failure(s)`);
  process.exit(1);
}
console.log('img2sprite: all sprites, sheets and random art round-trip');
