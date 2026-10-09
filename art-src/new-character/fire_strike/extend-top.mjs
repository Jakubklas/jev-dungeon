// Makes the fire strike's column 30 px taller without touching anything else: reads the converter's output
// (fire_strike.js), prepends EXTRA empty rows to every frame and, in the frames whose beam was cut off by the top
// of the source sheet, continues each cut column straight up to the new top with its own top pixel. Only columns
// that start at the frame's cut edge (its topmost beam row, or one below) and run at least MIN_RUN opaque pixels
// down count as beam, so sparks and smoke never become streaks. Writes fire_strike-tall.js (same format), whose
// palette and rows go into public/sprites.js; the anchor moves down by EXTRA.
// Usage: node art-src/new-character/fire_strike/extend-top.mjs
import { readFileSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const EXTRA = 30, CUT_MAX = 8, MIN_RUN = 8;

const src = readFileSync(join(HERE, 'fire_strike.js'), 'utf8');
const names = [...src.matchAll(/^const (FIRE_STRIKE_\w+) =/gm)].map((m) => m[1]);
const data = new Function(`${src}\nreturn { ${names.join(', ')} };`)();
const rowNames = names.filter((n) => n.startsWith('FIRE_STRIKE_ROW'));

let extended = 0;
const tall = (g) => {
  const w = g[0].length;
  const top = (x) => { for (let y = 0; y < g.length; y++) if (g[y][x] !== '.') return y; return -1; };
  const run = (x, t) => { let n = 0; while (t + n < g.length && g[t + n][x] !== '.') n++; return n; };
  const beam = [];
  for (let x = 0; x < w; x++) { const t = top(x); if (t >= 0 && t <= CUT_MAX && run(x, t) >= MIN_RUN) beam.push([x, t]); }
  const cut = beam.length ? Math.min(...beam.map(([, t]) => t)) : null;
  const out = [...Array.from({ length: EXTRA }, () => '.'.repeat(w)), ...g].map((r) => [...r]);
  for (const [x, t] of beam) {
    if (t > cut + 1) continue; // a taper pixel below the cut edge, not a cut column
    for (let y = 0; y < t + EXTRA; y++) out[y][x] = g[t][x];
  }
  if (cut !== null) extended++;
  return out.map((r) => r.join(''));
};

const rows = Object.fromEntries(rowNames.map((n) => [n, data[n].map(tall)]));
const fmt = (n, frames) => `const ${n} = [\n${frames.map((g) => `  [\n${g.map((r) => `    '${r}',`).join('\n')}\n  ],`).join('\n')}\n];\n`;
const pal = src.slice(src.indexOf('const FIRE_STRIKE_PAL'), src.indexOf('};', src.indexOf('const FIRE_STRIKE_PAL')) + 3);
const h = rows[rowNames[0]][0].length, w = rows[rowNames[0]][0][0].length;
writeFileSync(join(HERE, 'fire_strike-tall.js'), `// fire_strike ${w}x${h}: fire_strike.js with the column extended ${EXTRA} px up (extend-top.mjs).\n${pal}\n${rowNames.map((n) => fmt(n, rows[n])).join('\n')}`);
console.log(`wrote fire_strike-tall.js: ${w}x${h}, ${extended} frames extended`);
