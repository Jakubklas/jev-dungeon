// Draws ART.fire_strike's 18 frames over a 5x5 patch of 32x16 iso floor cells (game colours), anchored
// on the centre cell (outlined), at 3x: art-src/new-character/fire_strike/fire_strike-game-preview.png
import { writeFileSync } from 'node:fs';
import { PNG } from 'pngjs';
import { ART } from '../../../public/sprites.js';
const A = ART.fire_strike, K = 3, FW = 170, FH = 170, CX = 85, CY = 124;
const png = new PNG({ width: FW * 6 * K, height: FH * 3 * K });
const rgb = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
const put = (x, y, c) => { for (let j = 0; j < K; j++) for (let i = 0; i < K; i++) { const o = ((y * K + j) * png.width + x * K + i) * 4; png.data.set([...c, 255], o); } };
for (let f = 0; f < 18; f++) {
  const ox = (f % 6) * FW, oy = Math.floor(f / 6) * FH;
  for (let y = 0; y < FH; y++) for (let x = 0; x < FW; x++) put(ox + x, oy + y, [12, 14, 24]);
  for (let gy = -2; gy <= 2; gy++) for (let gx = -2; gx <= 2; gx++) {
    const cx = CX + (gx - gy) * 16, cy = CY + (gx + gy) * 8;
    for (let y = -8; y < 8; y++) for (let x = -16; x < 16; x++) {
      const e = Math.abs(x + .5) / 16 + Math.abs(y + .5) / 8;
      if (e > 1) continue;
      const edge = e > .88, mid = gx === 0 && gy === 0;
      put(ox + cx + x, oy + cy + y, edge ? (mid ? [255, 255, 255] : [24, 30, 46]) : ((gx + gy) & 1 ? [52, 62, 86] : [60, 72, 98]));
    }
  }
  const g = A.frames[f];
  g.forEach((row, y) => [...row].forEach((ch, x) => { if (ch !== '.') put(ox + CX - A.anchorX + x, oy + CY - A.anchorY + y, rgb(A.palette[ch])); }));
}
writeFileSync(new URL('./fire_strike-game-preview.png', import.meta.url), PNG.sync.write(png));
