// Converts a PNG or JPEG (other formats via macOS `sips`), one sprite or a sprite sheet of
// animation frames, into the string-grid sprite format of public/sprites.js: a palette object plus rows of letters, '.' = transparent (STYLE_GUIDELINES.md,
// "Sprite format"). Two paths:
//   - pixel art, at any scale and even through JPEG: the pixel grid is detected and each art pixel
//     is read back exactly, so the sprite is 1:1 with the source;
//   - an illustration or photo: cropped to the character and downscaled to a size class (--size /
//     --height), which can't be 1:1 at 18x24 px.
// The image keeps its own colours (JPEG noise is merged); --snap pulls them onto the style guide.
// A sheet (--sheet, or --grid CxR) gives one animation per sheet row (--rows idle,walk), all frames
// sharing one palette, one pixel size and one registration so the animation doesn't jitter.
// Usage: node scripts/img2sprite.mjs <image> [--help for options]
// Also a module: `convert` / `convertSheet(path | { width, height, data }, opts)` (scripts/check-img2sprite.mjs uses them).

import { readFileSync, writeFileSync, mkdtempSync, mkdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, extname, basename, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { PNG } from 'pngjs';
import jpeg from 'jpeg-js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const LETTERS = 'abcdefghijklmnpqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'; // 'o' is kept for the outline
const MAX_COLORS = 32; // more distinct colours than this is noise (JPEG) or an illustration: reduce
const MAX_ART_COLORS = 48; // a grid whose cells need more colour groups than this is sliced shading, not pixel art
const NOISE_TOL = 0.02; // OKLab distance under which two cell colours are one colour plus noise
const MERGE_TOL = 0.045; // OKLab distance under which JPEG-noisy cell colours are one colour
const EDGE_T = 0.06; // OKLab step that counts as an edge between two pixels
const BG_TOL = 0.09; // OKLab distance from the border colour that still counts as background
const POCKET_TOL = 0.025; // an enclosed patch this close to the background colour is background too

// --- colour --------------------------------------------------------------------------------------

const lin = (c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
const gam = (c) => (c <= 0.0031308 ? 12.92 * c : 1.055 * c ** (1 / 2.4) - 0.055);
export function toLab(r, g, b) {
  const R = lin(r / 255), G = lin(g / 255), B = lin(b / 255);
  const l = Math.cbrt(0.4122214708 * R + 0.5363325363 * G + 0.0514459929 * B);
  const m = Math.cbrt(0.2119034982 * R + 0.6806995451 * G + 0.1073969566 * B);
  const s = Math.cbrt(0.0883024619 * R + 0.2817188376 * G + 0.6299787005 * B);
  return [0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
    1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
    0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s];
}
function toRgb([L, a, b]) {
  const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s = (L - 0.0894841775 * a - 1.291485548 * b) ** 3;
  const c = [4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s];
  return c.map((v) => Math.max(0, Math.min(255, Math.round(gam(Math.max(0, Math.min(1, v))) * 255))));
}
const dist = (p, q) => Math.hypot(p[0] - q[0], p[1] - q[1], p[2] - q[2]);
const hex = ([r, g, b]) => '#' + [r, g, b].map((v) => v.toString(16).padStart(2, '0')).join('');
const fromHex = (h) => { const n = parseInt(h.slice(1), 16); return [n >> 16, (n >> 8) & 255, n & 255]; };

// --- decode --------------------------------------------------------------------------------------

export function decode(path) {
  const ext = extname(path).toLowerCase();
  if (ext === '.png') {
    const png = PNG.sync.read(readFileSync(path));
    return { width: png.width, height: png.height, data: png.data, hasAlpha: true };
  }
  if (ext === '.jpg' || ext === '.jpeg') {
    const img = jpeg.decode(readFileSync(path), { useTArray: true, formatAsRGBA: true, maxMemoryUsageInMB: 1024 });
    return { width: img.width, height: img.height, data: img.data, hasAlpha: false };
  }
  // webp, heic, gif, tiff...: let macOS convert it.
  if (process.platform !== 'darwin') throw new Error(`unsupported format ${ext}: save it as PNG or JPEG`);
  const out = join(mkdtempSync(join(tmpdir(), 'img2sprite-')), 'in.png');
  execFileSync('sips', ['-s', 'format', 'png', path, '--out', out], { stdio: 'ignore' });
  return decode(out);
}

// --- background and crop -------------------------------------------------------------------------

// Opaque mask: the PNG's alpha when it has real transparency, otherwise a flood fill from the
// border through pixels close to the border's main colour (so a character sharing that colour
// inside keeps it).
function foreground(img, lab, bg, keepHoles = false) {
  const { width: w, height: h, data } = img;
  const mask = new Uint8Array(w * h).fill(1);
  if (bg === 'none') return { mask, how: 'none' };
  let clear = 0;
  for (let i = 0; i < w * h; i++) if (data[i * 4 + 3] < 128) { mask[i] = 0; clear++; }
  if (img.hasAlpha && clear > 0) return { mask, how: 'alpha' };
  const border = [];
  for (let x = 0; x < w; x++) border.push(x, (h - 1) * w + x);
  for (let y = 0; y < h; y++) border.push(y * w, y * w + w - 1);
  // Main border colour: the border pixel with the most border pixels near it (sampled).
  const step = Math.max(1, Math.floor(border.length / 400));
  let ref = null, best = -1;
  for (let i = 0; i < border.length; i += step) {
    let n = 0;
    for (let j = 0; j < border.length; j += step) if (dist(lab(border[i]), lab(border[j])) < BG_TOL) n++;
    if (n > best) { best = n; ref = lab(border[i]); }
  }
  // A real margin is mostly one colour; a character that fills the frame is not background.
  if (best < 0.75 * Math.ceil(border.length / step)) return { mask, how: 'none (border not one colour)' };
  const queue = [];
  for (const i of border) if (mask[i] && dist(lab(i), ref) < BG_TOL) { mask[i] = 0; queue.push(i); }
  while (queue.length) {
    const i = queue.pop(), x = i % w;
    for (const j of [x > 0 ? i - 1 : -1, x < w - 1 ? i + 1 : -1, i - w, i + w]) {
      if (j >= 0 && j < w * h && mask[j] && dist(lab(j), ref) < BG_TOL) { mask[j] = 0; queue.push(j); }
    }
  }
  // Everything matched the border: there is no margin, the whole image is the character.
  if (!mask.includes(1)) return { mask: mask.fill(1), how: 'none (no margin around the art)' };
  // Pockets the fill can't reach (between the legs, inside a ring): a connected patch whose median
  // colour is the background itself (tighter than BG_TOL, so a near-white highlight stays).
  let pockets = 0;
  if (keepHoles) return { mask, how: `flood fill from the border (${hex(toRgb(ref))})` };
  const seen = new Uint8Array(w * h);
  for (let s = 0; s < w * h; s++) {
    if (!mask[s] || seen[s] || dist(lab(s), ref) >= BG_TOL) continue;
    const comp = [s], d = [];
    seen[s] = 1;
    for (let q = 0; q < comp.length; q++) {
      const i = comp[q], x = i % w;
      d.push(dist(lab(i), ref));
      for (const j of [x > 0 ? i - 1 : -1, x < w - 1 ? i + 1 : -1, i - w, i + w]) {
        if (j >= 0 && j < w * h && mask[j] && !seen[j] && dist(lab(j), ref) < BG_TOL) { seen[j] = 1; comp.push(j); }
      }
    }
    if (median(d) < POCKET_TOL) { for (const i of comp) mask[i] = 0; pockets++; }
  }
  return { mask, how: `flood fill from the border (${hex(toRgb(ref))})${pockets ? `, ${pockets} enclosed pocket(s) cleared` : ''}` };
}

// --- pixel-grid detection ------------------------------------------------------------------------

// Edge histogram along one axis: for each boundary position, how many lines have a colour step
// there. The step at boundary k compares the pixels `span` either side, so a soft (smoothly
// resized) edge that fades over many pixels still registers; each edge counts once, at the middle
// of its strongest run (non-max suppression over +-span).
function edgeHistogram(px, len, lines, span = 1) {
  const H = new Float64Array(len + 1);
  const g = new Float64Array(len + 1), wmax = new Float64Array(len + 1), dq = new Int32Array(len + 1);
  for (let ln = 0; ln < lines; ln++) {
    for (let k = 1; k < len; k++) {
      const a = px(ln, Math.max(0, k - span)), b = px(ln, Math.min(len - 1, k + span - 1));
      g[k] = (a === null) !== (b === null) ? 1 : a === null ? 0 : dist(a, b);
    }
    // Sliding maximum over +-span (monotonic deque), so wide spans stay linear.
    let head = 0, tail = 0;
    for (let k = 1, j = 1; k < len; k++) {
      for (; j < len && j <= k + span; j++) {
        while (tail > head && g[dq[tail - 1]] <= g[j]) tail--;
        dq[tail++] = j;
      }
      while (dq[head] < k - span) head++;
      wmax[k] = g[dq[head]];
    }
    for (let k = 1; k < len;) {
      if (!(g[k] > EDGE_T && g[k] >= wmax[k] - 1e-6)) { k++; continue; }
      let e = k;
      while (e + 1 < len && Math.abs(g[e + 1] - g[k]) <= 1e-6) e++;
      H[Math.round((k + e) / 2)]++;
      k = e + 1;
    }
  }
  return H;
}

// How well a grid of pitch s fits an edge histogram: the share of edges within tol of some grid
// line, at the best offset. Offsets are binned at half a pixel and searched circularly.
function gridFit(H, len, s) {
  // Tolerance grows with the pitch (JPEG and resize fuzz) but stays a small share of it, so a
  // wrong small pitch can't catch most edges by accident.
  const tol = Math.min(Math.max(0.75, 0.08 * s), 0.15 * s), nb = Math.ceil(s * 2), acc = new Float64Array(nb);
  let total = 0;
  for (let x = 1; x < len; x++) if (H[x]) { acc[Math.floor(((x % s) * 2)) % nb] += H[x]; total += H[x]; }
  const half = Math.round(tol * 2);
  let best = -1, at = 0;
  for (let i = 0; i < nb; i++) {
    let sum = 0;
    for (let d = -half; d <= half; d++) sum += acc[(i + d + nb) % nb];
    if (sum > best) { best = sum; at = i; }
  }
  const p = (at + 0.5) / 2;
  // Cells start at the grid line at or before the box edge (0); a line just inside the edge is
  // JPEG fuzz at the edge itself.
  return { s, o: p <= tol ? p : p - s, score: total ? best / total : 0 };
}

// Pixel sizes worth trying, largest first: for each run of pitches (step 0.5%) whose grid lines
// carry at least 85% of the edges, the best-fitting one, with its offset.
function scaleCandidates(H, len) {
  let total = 0;
  for (let k = 1; k < len; k++) total += H[k];
  if (total < 8) return [];
  const runs = [];
  let run = null;
  for (let s = 2; s <= len / 2; s *= 1.005) {
    const f = gridFit(H, len, s);
    if (f.score >= 0.85) {
      if (!run) runs.push((run = []));
      run.push(f);
    } else run = null;
  }
  // Per run, the middle of the pitches that fit best (a crisp grid fits a small range equally well).
  return runs.map((r) => {
    const top = Math.max(...r.map((f) => f.score));
    const best = r.filter((f) => f.score >= top - 1e-9);
    return best[best.length >> 1];
  }).sort((a, b) => b.s - a.s);
}

// The simple fit, tried first: the grid starts at the box edge, so the pitch is len / n for a
// whole number of cells n whose lines carry at least 85% of the edges. Exact for clean art at any
// scale; the free-offset fit above covers art whose edge JPEG fuzz has moved.
function edgeAlignedCandidates(H, len) {
  let total = 0;
  for (let k = 1; k < len; k++) total += H[k];
  if (total < 8) return [];
  const out = [];
  for (let n = 2; n <= len / 2; n++) {
    const s = len / n, tol = s >= 6 ? 1 : 0;
    let hit = 0;
    for (let k = 1; k < n; k++) {
      const c = Math.round(k * s);
      for (let d = -tol; d <= tol; d++) hit += H[c + d] ?? 0;
    }
    if (hit / total >= 0.85) out.push({ s, o: 0, score: hit / total });
  }
  return out.reverse();
}

// --- sampling ------------------------------------------------------------------------------------

// A grid: cols x rows cells of sx x sy source pixels, the first starting at (ox, oy) in box
// coordinates (a fraction of a pixel, or just before the box edge). cells[i] is an OKLab colour or null.
const gridOf = (box, ax, ay, cells, cols, rows) => ({ ox: ax.o, oy: ay.o, sx: ax.s, sy: ay.s, cols, rows, cells });

const median = (v) => { v.sort((a, b) => a - b); return v[v.length >> 1]; };

// One art pixel per cell: transparent if most of its inner pixels are background, otherwise the
// per-channel median of its inner pixels (the outer `inset` is skipped: JPEG bleed and soft edges
// live there).
function sampleGrid(at, box, ax, ay, inset = 1 / 4) {
  const cols = Math.max(1, Math.ceil((box.w - ax.o) / ax.s - 0.3)), rows = Math.max(1, Math.ceil((box.h - ay.o) / ay.s - 0.3));
  const cells = [];
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const x0 = ax.o + c * ax.s, y0 = ay.o + r * ay.s;
      const xa = Math.floor(x0 + ax.s * inset), xb = Math.max(xa + 1, Math.ceil(x0 + ax.s * (1 - inset)));
      const ya = Math.floor(y0 + ay.s * inset), yb = Math.max(ya + 1, Math.ceil(y0 + ay.s * (1 - inset)));
      const L = [], A = [], B = [];
      let n = 0;
      for (let y = ya; y < yb; y++) for (let x = xa; x < xb; x++) {
        n++;
        const p = at(x, y);
        if (p) { L.push(p[0]); A.push(p[1]); B.push(p[2]); }
      }
      cells.push(L.length * 2 > n ? [median(L), median(A), median(B)] : null);
    }
  }
  return gridOf(box, ax, ay, cells, cols, rows);
}

// Pixel-art downscale onto a cols x rows grid. Each cell takes the colour of its dominant group of
// similar source pixels (the mean of the pixels near the best candidate), not the cell average, so
// hues stay true instead of turning to mud. A group that stands out from the cell's average (a rune,
// an eye, an outline) weighs more, so small bright and dark details survive. Opaque if at least 40%
// covered.
function resampleMode(at, box, cols, rows) {
  const cells = [];
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const xa = Math.floor(c * box.w / cols), xb = Math.max(xa + 1, Math.floor((c + 1) * box.w / cols));
      const ya = Math.floor(r * box.h / rows), yb = Math.max(ya + 1, Math.floor((r + 1) * box.h / rows));
      const px = [], mean = [0, 0, 0];
      let n = 0;
      for (let y = ya; y < yb; y++) for (let x = xa; x < xb; x++) {
        n++;
        const p = at(x, y);
        if (p) { px.push(p); mean[0] += p[0]; mean[1] += p[1]; mean[2] += p[2]; }
      }
      if (px.length < 0.4 * n) { cells.push(null); continue; }
      mean.forEach((v, i) => { mean[i] = v / px.length; });
      const step = Math.max(1, Math.floor(px.length / 40));
      let best = null, bestW = -1;
      for (let i = 0; i < px.length; i += step) {
        const near = px.filter((q) => dist(q, px[i]) < 0.06);
        const w = near.length * (1 + 6 * dist(px[i], mean));
        if (w > bestW) { bestW = w; best = near; }
      }
      const sum = [0, 0, 0];
      for (const q of best) { sum[0] += q[0]; sum[1] += q[1]; sum[2] += q[2]; }
      cells.push(sum.map((v) => v / best.length));
    }
  }
  return gridOf(box, { s: box.w / cols, o: 0 }, { s: box.h / rows, o: 0 }, cells, cols, rows);
}

// Share of source pixels (opaque in the source or in the grid) whose colour is within reach of
// their cell's colour: how faithfully the grid redraws the source. `core` looks only at the middle
// third of each cell (a soft edge blends the rest with the neighbours by design).
function fidelity(at, box, grid, colorOf, tol = 0.1, core = false) {
  let ok = 0, n = 0;
  for (let y = 0; y < box.h; y++) for (let x = 0; x < box.w; x++) {
    const fx = (x + 0.5 - grid.ox) / grid.sx, fy = (y + 0.5 - grid.oy) / grid.sy;
    if (core && (fx % 1 < 1 / 3 || fx % 1 >= 2 / 3 || fy % 1 < 1 / 3 || fy % 1 >= 2 / 3)) continue;
    const c = Math.floor(fx), r = Math.floor(fy);
    const cell = c >= 0 && r >= 0 && c < grid.cols && r < grid.rows ? grid.cells[r * grid.cols + c] : null;
    const p = at(x, y), q = cell ? colorOf(cell) : null;
    if (!p && !q) continue;
    n++;
    if (p && q && dist(p, q) < tol) ok++;
  }
  return n ? ok / n : 1;
}

// Drops the outer rows and columns that are empty in every frame (the same amount from each, so
// frames keep their registration).
function trimGrids(grids) {
  const used = (g, c, r) => g.cells[r * g.cols + c] !== null;
  const cols = Math.max(...grids.map((g) => g.cols)), rows = Math.max(...grids.map((g) => g.rows));
  let c0 = cols, c1 = -1, r0 = rows, r1 = -1;
  for (const g of grids) for (let r = 0; r < g.rows; r++) for (let c = 0; c < g.cols; c++) {
    if (!used(g, c, r)) continue;
    if (c < c0) c0 = c; if (c > c1) c1 = c; if (r < r0) r0 = r; if (r > r1) r1 = r;
  }
  return grids.map((g) => {
    const cells = [];
    for (let r = r0; r <= r1; r++) for (let c = c0; c <= c1; c++) cells.push(c < g.cols && r < g.rows ? g.cells[r * g.cols + c] : null);
    return { ...g, ox: g.ox + c0 * g.sx, oy: g.oy + r0 * g.sy, cols: c1 - c0 + 1, rows: r1 - r0 + 1, cells };
  });
}

// --- colours -------------------------------------------------------------------------------------

// How many colour groups (MERGE_TOL apart) the cells need; stops counting past `limit`.
function colourGroups(cells, limit) {
  const groups = [];
  for (const c of cells) {
    if (c && !groups.some((g) => dist(g, c) < MERGE_TOL)) {
      groups.push(c);
      if (groups.length > limit) break;
    }
  }
  return groups.length;
}

// k-means in OKLab with a deterministic farthest-point start.
function kmeans(points, weights, k) {
  const centres = [points[weights.indexOf(Math.max(...weights))]];
  while (centres.length < k) {
    let far = -1, at = 0;
    points.forEach((p, i) => { const d = Math.min(...centres.map((c) => dist(p, c))) * Math.sqrt(weights[i]); if (d > far) { far = d; at = i; } });
    centres.push(points[at]);
  }
  for (let it = 0; it < 30; it++) {
    const sum = centres.map(() => [0, 0, 0, 0]);
    points.forEach((p, i) => {
      let b = 0;
      for (let c = 1; c < k; c++) if (dist(p, centres[c]) < dist(p, centres[b])) b = c;
      const s = sum[b], w = weights[i];
      s[0] += p[0] * w; s[1] += p[1] * w; s[2] += p[2] * w; s[3] += w;
    });
    sum.forEach((s, c) => { if (s[3]) centres[c] = [s[0] / s[3], s[1] / s[3], s[2] / s[3]]; });
  }
  return centres;
}

// The sprite's palette from its cell colours: exact when the source is clean, otherwise noisy
// colours are merged (greedy by frequency, then k-means down to the cap).
function buildPalette(cells, maxColors, forced) {
  const counts = new Map();
  for (const c of cells) if (c) { const h = hex(toRgb(c)); counts.set(h, (counts.get(h) ?? 0) + 1); }
  let colours = [...counts.keys()].map((h) => ({ rgb: fromHex(h), n: counts.get(h) }));
  colours.forEach((c) => { c.lab = toLab(...c.rgb); });
  const cap = forced ?? maxColors;
  if (colours.length <= cap) return colours.map((c) => c.lab);
  // Merge only near-identical colours (JPEG noise) into the most frequent one, which stays the
  // group's colour so merging can't drift a hue (green into grey); then k-means down to the cap.
  colours.sort((a, b) => b.n - a.n);
  const groups = [];
  for (const c of colours) {
    const g = groups.find((g) => dist(g.lab, c.lab) < NOISE_TOL);
    if (g) g.n += c.n;
    else groups.push({ lab: c.lab, n: c.n });
  }
  if (groups.length <= cap) return groups.map((g) => g.lab);
  return kmeans(groups.map((g) => g.lab), groups.map((g) => g.n), cap);
}

// Every #rrggbb in STYLE_GUIDELINES.md's Palette section, plus the sprite palettes with their letters.
async function stylePalette() {
  const md = readFileSync(join(ROOT, 'STYLE_GUIDELINES.md'), 'utf8');
  const section = md.slice(md.indexOf('## Palette'), md.indexOf('## Geometry'));
  const out = new Map();
  for (const h of section.match(/#[0-9a-fA-F]{6}\b/g) ?? []) out.set(h.toLowerCase(), null);
  const { ART } = await import(pathToFileURL(join(ROOT, 'public/sprites.js')).href);
  for (const def of Object.values(ART)) for (const [k, h] of Object.entries(def.palette)) out.set(h.toLowerCase(), out.get(h.toLowerCase()) ?? k);
  return [...out].map(([h, letter]) => ({ hex: h, letter, lab: toLab(...fromHex(h)) }));
}

// --- frames --------------------------------------------------------------------------------------

const inRect = (b, r) => b.x0 >= r.x && b.y0 >= r.y && b.x0 + b.w <= r.x + r.w && b.y0 + b.h <= r.y + r.h;

// Tight box of the opaque pixels inside a rectangle, or null when it is empty.
function bboxIn(mask, W, r) {
  let x0 = Infinity, y0 = Infinity, x1 = -1, y1 = -1;
  for (let y = r.y; y < r.y + r.h; y++) for (let x = r.x; x < r.x + r.w; x++) {
    if (!mask[y * W + x]) continue;
    if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
  }
  return x1 < 0 ? null : { x0, y0, w: x1 - x0 + 1, h: y1 - y0 + 1 };
}

// A sheet's frame slots. `grid` [cols, rows] splits the image evenly. Without it, frames are the
// blocks between fully empty rows and columns (gutters); when every band holds the same number of
// frames and each sits inside its even slot, it is an even grid after all. An even grid keeps each
// frame's place in its slot, so the animation doesn't jitter; otherwise frames are bottom-centred.
function frameRects(mask, W, H, grid) {
  const even = (c, r) => {
    const out = [];
    for (let j = 0; j < r; j++) for (let i = 0; i < c; i++) {
      const x = Math.round(i * W / c), y = Math.round(j * H / r);
      out.push({ x, y, w: Math.round((i + 1) * W / c) - x, h: Math.round((j + 1) * H / r) - y, row: j, col: i });
    }
    return out;
  };
  if (grid) return { rects: even(...grid), even: true, layout: `grid ${grid[0]}x${grid[1]}` };
  const runs = (n, empty) => {
    const out = [];
    for (let i = 0; i < n;) {
      if (empty(i)) { i++; continue; }
      const a = i;
      while (i < n && !empty(i)) i++;
      out.push([a, i]);
    }
    return out;
  };
  const rowEmpty = (y) => { for (let x = 0; x < W; x++) if (mask[y * W + x]) return false; return true; };
  const bands = runs(H, rowEmpty).map(([ya, yb], row) => runs(W, (x) => {
    for (let y = ya; y < yb; y++) if (mask[y * W + x]) return false;
    return true;
  }).map(([xa, xb], col) => ({ x: xa, y: ya, w: xb - xa, h: yb - ya, row, col })));
  // Even slots: as many columns as the longest band, one row per band. Every block must sit inside
  // a slot (several blocks in one slot are one frame: a detached sword or plume).
  const found = bands.flat();
  const c = Math.max(0, ...bands.map((b) => b.length)), r = bands.length;
  if (c) {
    const slots = even(c, r);
    if (found.every((f) => slots.some((s) => inRect({ x0: f.x, y0: f.y, w: f.w, h: f.h }, s)))) return { rects: slots, even: true, layout: `even grid ${c}x${r} (found)` };
  }
  return { rects: found, even: false, layout: `${found.length} frames between gutters, bottom-centred` };
}

// Distinct colours in a box (coarsely rounded): real 1x pixel art has few, a photo or a soft
// image has many.
function colourCount(at, box) {
  const seen = new Set();
  for (let y = 0; y < box.h; y++) for (let x = 0; x < box.w; x++) {
    const p = at(x, y);
    if (p) seen.add(p.map((v) => Math.round(v * 100)).join());
  }
  return seen.size;
}

// Pixel size and grid offset of pixel art. Edges are measured at growing spans (1 px for crisp
// art, wider for soft edges from a smooth resize); at each span the largest pitch whose grid
// redraws the source faithfully wins, and the largest over all spans is the answer: too fine a
// grid also redraws a soft image faithfully, but a too coarse one never passes (its cells straddle
// real art pixels). A soft match samples and judges cell cores only. Nothing found: small art with
// few colours is 1x, anything else is not pixel art (null).
// Returns { x: { s, o }, y: { s, o }, soft, span }.
function detectScale(at, box, opts) {
  const hx = (span) => edgeHistogram((y, x) => at(x, y), box.w, box.h, span);
  const hy = (span) => edgeHistogram((x, y) => at(x, y), box.h, box.w, span);
  if (opts.scale) return { x: gridFit(hx(1), box.w, opts.scale), y: gridFit(hy(1), box.h, opts.scale), soft: false, span: 1 };
  let best = null;
  for (let span = 1; span === 1 || span * 6 <= Math.min(box.w, box.h); span *= 2) {
    const Hx = hx(span), Hy = hy(span), soft = span > 1;
    const pairsOf = (xs, ys) => {
      const out = [];
      for (const x of xs) for (const y of ys) if (x.s >= span && y.s >= span && Math.abs(x.s - y.s) / Math.min(x.s, y.s) < 0.15) out.push({ x, y });
      return out.sort((a, b) => b.x.s * b.y.s - a.x.s * a.y.s);
    };
    // Edge-aligned grids first (crisp only), then free-offset ones.
    const pairs = [
      ...(soft ? [] : pairsOf(edgeAlignedCandidates(Hx, box.w), edgeAlignedCandidates(Hy, box.h))),
      ...pairsOf(scaleCandidates(Hx, box.w), scaleCandidates(Hy, box.h)),
    ];
    for (const { x, y } of pairs.slice(0, 6)) {
      if (best && x.s * y.s <= best.x.s * best.y.s) break;
      const g = sampleGrid(at, box, x, y, soft ? 1 / 3 : 1 / 4);
      if (fidelity(at, box, g, (c) => c, 0.1, soft) >= (soft ? 0.85 : 0.9) && colourGroups(g.cells, MAX_ART_COLORS) <= MAX_ART_COLORS) {
        // A crisp grid that redraws the art is the answer; soft spans only compete among themselves.
        if (!soft) return { x, y, soft, span };
        best = { x, y, soft, span };
        break;
      }
    }
  }
  if (best) return best;
  return box.w <= 128 && box.h <= 128 && colourCount(at, box) <= 64 ? { x: { s: 1, o: 0 }, y: { s: 1, o: 0 }, soft: false, span: 1 } : null;
}

// --- convert -------------------------------------------------------------------------------------

// Converts one image into one or more frames sharing a palette. A single sprite is a sheet of one.
// opts: { sheet, grid: [c, r], rows: [names], flip, size: [w, h], height, scale, colors, snap, bg, keepHoles }.
export async function convertSheet(input, opts = {}) {
  const img = typeof input === 'string' ? decode(input) : { hasAlpha: true, ...input };
  const { width: W, height: H, data } = img;
  // OKLab per pixel in one typed array (a 2048 px image stays tens of MB); lab(i) is a view.
  const labs = new Float32Array(W * H * 3);
  for (let i = 0; i < W * H; i++) labs.set(toLab(data[i * 4], data[i * 4 + 1], data[i * 4 + 2]), i * 3);
  const lab = (i) => labs.subarray(i * 3, i * 3 + 3);
  const fg = foreground(img, lab, opts.bg ?? 'auto', opts.keepHoles);
  const layout = opts.sheet || opts.grid ? frameRects(fg.mask, W, H, opts.grid)
    : { rects: [{ x: 0, y: 0, w: W, h: H, row: 0, col: 0 }], even: true, layout: 'single sprite' };
  const frames = layout.rects.map((r) => ({ ...r, box: bboxIn(fg.mask, W, r) })).filter((f) => f.box);
  if (!frames.length) throw new Error('the image is all background: nothing to convert');
  const atIn = (b) => (x, y) => {
    const X = b.x0 + x, Y = b.y0 + y;
    if (X < 0 || Y < 0 || X >= W || Y >= H) return null;
    const i = Y * W + X;
    return fg.mask[i] ? lab(i) : null;
  };

  // Even layouts sample every frame through one box: the union of the frames' boxes in their slot.
  if (layout.even) {
    const rel = frames.map((f) => [f.box.x0 - f.x, f.box.y0 - f.y, f.box.x0 + f.box.w - f.x, f.box.y0 + f.box.h - f.y]);
    const [x0, y0] = [Math.min(...rel.map((r) => r[0])), Math.min(...rel.map((r) => r[1]))];
    const [x1, y1] = [Math.max(...rel.map((r) => r[2])), Math.max(...rel.map((r) => r[3]))];
    for (const f of frames) f.sbox = { x0: f.x + x0, y0: f.y + y0, w: x1 - x0, h: y1 - y0 };
  } else for (const f of frames) f.sbox = f.box;

  // One pixel size for the whole sheet, detected on its biggest frame.
  const ref = frames.reduce((a, b) => (b.box.w * b.box.h > a.box.w * a.box.h ? b : a));
  const scale = opts.size || opts.height ? null : detectScale(atIn(ref.box), ref.box, opts);
  const report = { source: `${W}x${H}`, background: fg.how, layout: layout.layout, frames: frames.length };
  if (scale) {
    Object.assign(report, { mode: scale.soft ? 'pixel art (soft edges)' : 'pixel art', scale: +((scale.x.s + scale.y.s) / 2).toFixed(2) });
    // Each frame finds its own grid offset at the sheet's pitch (slots needn't sit on the grid).
    const grids = frames.map((f) => {
      const at = atIn(f.sbox);
      const x = f === ref && !layout.even ? scale.x : gridFit(edgeHistogram((y, x) => at(x, y), f.sbox.w, f.sbox.h, scale.span), f.sbox.w, scale.x.s);
      const y = f === ref && !layout.even ? scale.y : gridFit(edgeHistogram((x, y) => at(x, y), f.sbox.h, f.sbox.w, scale.span), f.sbox.h, scale.y.s);
      return sampleGrid(at, f.sbox, x, y, scale.soft ? 1 / 3 : 1 / 4);
    });
    trimGrids(grids).forEach((g, i) => { frames[i].grid = g; });
  } else {
    // Illustration: --size WxH is exact for the reference frame; --height keeps the aspect ratio.
    const rows = opts.size ? opts.size[1] : (opts.height ?? 24);
    const k = rows / ref.sbox.h, kx = opts.size ? opts.size[0] / ref.sbox.w : k;
    for (const f of frames) f.grid = resampleMode(atIn(f.sbox), f.sbox, Math.max(1, Math.round(f.sbox.w * kx)), Math.max(1, Math.round(f.sbox.h * k)));
    // The source's 1 px outline is thinner than one new art pixel and gets lost: redraw it on the
    // silhouette edge in the darkest colour (STYLE_GUIDELINES: every sprite has a dark outline).
    if (!opts.noOutline) {
      const dark = frames.flatMap((f) => f.grid.cells).filter(Boolean).reduce((a, b) => (b[0] < a[0] ? b : a));
      if (dark[0] < 0.35) {
        for (const { grid: g } of frames) {
          const edge = g.cells.map((c, i) => {
            if (!c) return false;
            const x = i % g.cols, y = (i / g.cols) | 0;
            return [[x - 1, y], [x + 1, y], [x, y - 1], [x, y + 1]].some(([a, b]) => a < 0 || b < 0 || a >= g.cols || b >= g.rows || !g.cells[b * g.cols + a]);
          });
          g.cells = g.cells.map((c, i) => (edge[i] ? dark : c));
        }
        report.outline = 'redrawn';
      }
    }
    report.mode = 'downscaled illustration (not 1:1: detail below one art pixel is lost)';
  }

  // Palette: the image's own colours over all frames; --snap moves each onto the nearest
  // style-guide colour within tol.
  const centres = buildPalette(frames.flatMap((f) => f.grid.cells), MAX_COLORS, opts.colors);
  const nearest = (c) => centres.reduce((b, p, i) => (dist(c, p) < dist(c, centres[b]) ? i : b), 0);
  for (const f of frames) f.index = f.grid.cells.map((c) => (c ? nearest(c) : -1));
  const colours = centres.map((lab) => ({ lab, hex: hex(toRgb(lab)), letter: null }));
  if (opts.snap) {
    const style = await stylePalette();
    let snapped = 0;
    for (const c of colours) {
      const s = style.reduce((b, p) => (dist(c.lab, p.lab) < dist(c.lab, b.lab) ? p : b));
      if (dist(c.lab, s.lab) <= opts.snap) { c.hex = s.hex; c.lab = s.lab; c.letter = s.letter; snapped++; }
    }
    report.snapped = `${snapped}/${colours.length} colours onto the style guide (tol ${opts.snap})`;
  }

  // Letters: the darkest colour touching transparency is the outline 'o'; the rest by lightness.
  const used = colours.map(() => 0), edge = colours.map(() => 0);
  for (const { index, grid: { cols, rows } } of frames) {
    index.forEach((k, i) => {
      if (k < 0) return;
      used[k]++;
      const x = i % cols, y = (i / cols) | 0;
      if (x === 0 || y === 0 || x === cols - 1 || y === rows - 1 || [i - 1, i + 1, i - cols, i + cols].some((j) => index[j] === -1)) edge[k]++;
    });
  }
  const live = colours.map((c, k) => ({ ...c, k })).filter((c) => used[c.k]);
  const outline = live.filter((c) => edge[c.k] && c.lab[0] < 0.4).sort((a, b) => a.lab[0] - b.lab[0])[0];
  const taken = new Set(['.']);
  if (outline) { outline.letter = 'o'; taken.add('o'); }
  for (const c of live) if (c.letter && c !== outline) { if (taken.has(c.letter)) c.letter = null; else taken.add(c.letter); }
  const free = [...LETTERS].filter((l) => !taken.has(l));
  for (const c of [...live].sort((a, b) => a.lab[0] - b.lab[0])) if (!c.letter) c.letter = free.shift();
  if (live.some((c) => !c.letter)) throw new Error(`too many colours (${live.length}): pass --colors N`);
  const letterOf = new Map(live.map((c) => [c.k, c.letter]));
  const palette = Object.fromEntries([...live].sort((a, b) => (a.letter === 'o' ? -1 : b.letter === 'o' ? 1 : a.lab[0] - b.lab[0])).map((c) => [c.letter, c.hex]));

  // Fidelity per frame against its source, before padding and flipping.
  const fids = frames.map((f) => fidelity(atIn(f.sbox), f.sbox, { ...f.grid, cells: f.index.map((k) => (k < 0 ? null : colours[k].lab)) }, (c) => c, 0.1, scale?.soft));

  // Rows of letters; frames found between gutters are padded to one size, bottom-centred.
  const C = Math.max(...frames.map((f) => f.grid.cols)), R = Math.max(...frames.map((f) => f.grid.rows));
  for (const f of frames) {
    const { cols, rows } = f.grid, ox = (C - cols) >> 1, oy = R - rows;
    f.rows = Array.from({ length: R }, (_, y) => {
      let s = '';
      for (let x = 0; x < C; x++) {
        const gx = x - ox, gy = y - oy;
        const k = gx >= 0 && gx < cols && gy >= 0 && gy < rows ? f.index[gy * cols + gx] : -1;
        s += k < 0 ? '.' : letterOf.get(k);
      }
      return opts.flip ? [...s].reverse().join('') : s;
    });
  }

  // Anchor: the middle of the lowest opaque row over all frames (the feet).
  const lowest = (g) => { let y = g.length - 1; while (y > 0 && !/[^.]/.test(g[y])) y--; return y; };
  const anchorY = Math.max(...frames.map((f) => lowest(f.rows)));
  const feet = frames.find((f) => /[^.]/.test(f.rows[anchorY])).rows[anchorY];
  const span = [...feet].flatMap((ch, x) => (ch === '.' ? [] : [x]));
  const anchorX = Math.round((span[0] + span[span.length - 1]) / 2);

  // Animations: one per sheet row (or band), named by --rows.
  const groups = [];
  for (const f of frames) {
    const name = opts.rows?.[f.row] ?? (frames.length === 1 ? 'a' : `row${f.row + 1}`);
    (groups.find((g) => g.name === name) ?? groups[groups.push({ name, frames: [] }) - 1]).frames.push(f.rows);
  }
  Object.assign(report, {
    size: `${C}x${R}`,
    colours: live.length,
    fidelity: +(Math.min(...fids) * 100).toFixed(1),
  });
  return { palette, frames: frames.map((f) => f.rows), groups, anchorX, anchorY, report, sources: frames.map((f) => ({ at: atIn(f.sbox), box: f.sbox })) };
}

// One sprite: the sheet path with a single frame.
export async function convert(input, opts = {}) {
  const res = await convertSheet(input, { ...opts, sheet: false, grid: undefined });
  return { ...res, grid: res.frames[0], source: res.sources[0] };
}

// --- output --------------------------------------------------------------------------------------

const constName = (s) => s.toUpperCase().replace(/[^A-Z0-9]+/g, '_');

export function toJs(name, res, file) {
  const N = constName(name), r = res.report;
  const head = `// ${name} ${r.size}, from ${file}: ${r.mode}${r.scale ? `, ${r.scale}x` : ''}; ${r.frames} frame${r.frames === 1 ? '' : 's'} (${r.layout}); fidelity ${r.fidelity}% (worst frame).`;
  const pal = [`const ${N}_PAL = {`, ...Object.entries(res.palette).map(([k, h]) => `  ${k}: '${h}',`), '};', ''];
  const grid = (g, pad) => g.map((row) => `${pad}'${row}',`);
  if (res.frames.length === 1) {
    return [head, ...pal, `const ${N}_A = [`, ...grid(res.frames[0], '  '), '];', '',
      `// ART entry: ${name}: { palette: ${N}_PAL, frames: [${N}_A], anchorX: ${res.anchorX}, anchorY: ${res.anchorY} },`, ''].join('\n');
  }
  const out = [head, ...pal];
  for (const g of res.groups) {
    out.push(`const ${N}_${constName(g.name)} = [`);
    for (const f of g.frames) out.push('  [', ...grid(f, '    '), '  ],');
    out.push('];', '');
  }
  const idle = res.groups.find((g) => g.name === 'idle') ?? res.groups[0];
  const walk = res.groups.find((g) => g.name === 'walk');
  out.push(`// ART entry: ${name}: { palette: ${N}_PAL, frames: ${N}_${constName(idle.name)}${walk ? `, walk: ${N}_WALK` : ''}, anchorX: ${res.anchorX}, anchorY: ${res.anchorY} },`,
    '// `frames` loop as the idle animation (ANIM_MS per frame); `walk` plays over WALK_MS after each step (monsters only, app.js).', '');
  return out.join('\n');
}

// Preview at zoom: a single sprite shows its source crop (left) next to the result; a sheet shows
// one animation per row. Mid-grey checkerboard behind.
export function writePreview(path, res, zoom = 8) {
  const rows = res.frames[0].length, cols = res.frames[0][0].length, h = rows * zoom, gap = zoom * 2;
  const single = res.frames.length === 1;
  const srcW = single ? Math.round(res.sources[0].box.w * h / res.sources[0].box.h) : 0;
  const perRow = Math.max(...res.groups.map((g) => g.frames.length));
  const png = new PNG({
    width: single ? srcW + gap + cols * zoom : perRow * (cols * zoom + gap) - gap,
    height: single ? h : res.groups.length * (h + gap) - gap,
  });
  const put = (x, y, [r, g, b]) => { const i = (y * png.width + x) * 4; png.data[i] = r; png.data[i + 1] = g; png.data[i + 2] = b; png.data[i + 3] = 255; };
  for (let y = 0; y < png.height; y++) for (let x = 0; x < png.width; x++) put(x, y, ((x >> 3) + (y >> 3)) & 1 ? [92, 92, 100] : [110, 110, 118]);
  const draw = (g, X, Y) => {
    for (let y = 0; y < h; y++) for (let x = 0; x < cols * zoom; x++) {
      const ch = g[Math.floor(y / zoom)][Math.floor(x / zoom)];
      if (ch !== '.') put(X + x, Y + y, fromHex(res.palette[ch]));
    }
  };
  if (single) {
    const { at, box } = res.sources[0];
    for (let y = 0; y < h; y++) for (let x = 0; x < srcW; x++) {
      const p = at(Math.floor(x * box.w / srcW), Math.floor(y * box.h / h));
      if (p) put(x, y, toRgb(p));
    }
    draw(res.frames[0], srcW + gap, 0);
  } else res.groups.forEach((g, j) => g.frames.forEach((f, i) => draw(f, i * (cols * zoom + gap), j * (h + gap))));
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, PNG.sync.write(png));
}

// --- CLI -----------------------------------------------------------------------------------------

const USAGE = `usage: node scripts/img2sprite.mjs <image> [options]
  --name n          constant names (default: the file name)
  --sheet           a sprite sheet: frames split at empty gutters (or --grid CxR to split evenly)
  --rows a,b,...    animation names per sheet row, e.g. idle,walk (walk becomes ART walk)
  --flip            mirror (art must face right)
  --size WxH | --height H   downscale an illustration to this size (default height 24)
  --scale N         force the pixel size of pixel art
  --colors N        reduce to N colours
  --snap [tol]      move colours onto the style guide palette (default tol 0.05)
  --bg auto|none    background removal (default auto)
  --no-outline      don't redraw the dark outline on downscaled art
  --keep-holes      keep enclosed background-coloured pockets (e.g. a pure white highlight on a white page)
  --out f.js | --preview f.png | --json`;

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const VALUED = new Set(['name', 'size', 'height', 'scale', 'colors', 'bg', 'out', 'preview', 'grid', 'rows']);
  const val = {}, flags = new Set();
  let file;
  const args = process.argv.slice(2);
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (!a.startsWith('--')) { file = a; continue; }
    const k = a.slice(2);
    if (VALUED.has(k)) val[k] = args[++i];
    else if (k === 'snap') val.snap = /^[\d.]+$/.test(args[i + 1] ?? '') ? Number(args[++i]) : 0.05;
    else flags.add(k);
  }
  if (!file || flags.has('help')) { console.error(USAGE); process.exit(file ? 0 : 2); }
  const dims = (s) => s?.split(/[x, ]+/i).map(Number);
  const opts = {
    sheet: flags.has('sheet'),
    grid: dims(val.grid),
    rows: val.rows?.split(','),
    flip: flags.has('flip'),
    size: dims(val.size),
    height: val.height && Number(val.height),
    scale: val.scale && Number(val.scale),
    colors: val.colors && Number(val.colors),
    snap: val.snap ?? 0,
    bg: val.bg,
    keepHoles: flags.has('keep-holes'),
    noOutline: flags.has('no-outline'),
  };
  const name = val.name ?? basename(file, extname(file)).toLowerCase().replace(/[^a-z0-9]+/g, '_');
  const res = await convertSheet(file, opts);
  const preview = val.preview ?? join(tmpdir(), 'img2sprite', `${name}-preview.png`);
  writePreview(preview, res);
  const r = res.report;
  if (flags.has('json')) {
    console.log(JSON.stringify({ name, palette: res.palette, animations: Object.fromEntries(res.groups.map((g) => [g.name, g.frames])), anchorX: res.anchorX, anchorY: res.anchorY, report: r, preview }, null, 2));
  } else {
    const js = toJs(name, res, basename(file));
    if (val.out) writeFileSync(val.out, js);
    else process.stdout.write(js);
    console.error(`${r.mode}${r.scale ? `, ${r.scale}x pixels` : ''}; ${r.frames} frame(s), ${r.layout}; ${r.source} -> ${r.size}, ${r.colours} colours, fidelity ${r.fidelity}%`);
    console.error(`background: ${r.background}${r.snapped ? `; snapped ${r.snapped}` : ''}`);
    console.error(`preview: ${preview}`);
  }
}
