// Prepares fire_stike.png (a 6x3 sheet, each frame painted on a 4x4 iso floor patch) for img2sprite:
// re-registers every frame on the floor diamond's bottom tip (the painted frames drift 1-7 px) into
// uniform 118x116 cells, and strips the painted stone (the game draws its own lit floor), keeping the
// glowing cracks, embers, flames and smoke. Writes fire_strike_sheet.png next to this file.
// Usage: node art-src/new-character/fire_strike/prep.mjs
import { readFileSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PNG } from 'pngjs';
import { toLab } from '../../../scripts/img2sprite.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
// Frame boxes between the sheet's empty gutters (measured on the source).
const COLS = [[7, 110], [114, 217], [221, 330], [332, 444], [447, 552], [556, 658]];
const ROWS = [[0, 112], [117, 226], [236, 346]];
const W = 118, H = 116, TX = 59, TY = 113; // output cell and where the diamond's bottom tip lands
const HW = 50, HH = 26; // diamond half-width / half-height (2:1 iso, like the game's 32x16 tiles)

const src = PNG.sync.read(readFileSync(join(HERE, 'fire_stike.png')));
const px = (x, y) => { const i = (y * src.width + x) * 4; return src.data.subarray(i, i + 4); };
const out = new PNG({ width: W * COLS.length, height: H * ROWS.length });

ROWS.forEach(([y0, y1], r) => COLS.forEach(([x0, x1], c) => {
  // The bottom tip: the lowest row with an opaque pixel, centred on its span.
  let ty = -1, xs = [];
  for (let y = y1; y >= y0 && ty < 0; y--) {
    xs = [];
    for (let x = x0; x <= x1; x++) if (px(x, y)[3] > 128) xs.push(x);
    if (xs.length) ty = y;
  }
  const tx = Math.round((xs[0] + xs[xs.length - 1]) / 2);
  for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
    const v = px(x, y);
    if (!v[3]) continue;
    const X = x - tx + TX, Y = y - ty + TY;
    if (X < 0 || Y < 0 || X >= W || Y >= H) continue;
    const dx = X - TX, dy = Y - (TY - HH);
    // The slab: the diamond plus its few px of side face below.
    const inSlab = Math.abs(dx) / HW + Math.abs(Math.min(0, dy)) / HH <= 1 && dy <= HH
      && Math.abs(dx) / HW + Math.max(0, dy - 4) / HH <= 1;
    if (inSlab) {
      const [L, a, b] = toLab(v[0], v[1], v[2]);
      const C = Math.hypot(a, b);
      if (C < 0.11 && L < 0.64) continue; // stone: dull and not bright (cracks and embers are saturated)
      if (Math.abs(dx) / HW + Math.abs(dy) / HH > 0.86 && L < 0.55) continue; // the slab's dark rim
    }
    out.data.set(v, ((r * H + Y) * W * COLS.length + c * W + X) * 4);
  }
}));
writeFileSync(join(HERE, 'fire_strike_sheet.png'), PNG.sync.write(out));
console.log('wrote', join(HERE, 'fire_strike_sheet.png'));
