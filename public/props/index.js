// Props and wall decor (CONTRACT.md, "v4: props and wall decor"): rasterises FLOOR_ART and
// WALL_ART once into light-banded sprites. The art files are loaded one by one, so a missing
// file only loses its own kind of art.
//
//   const p = await buildProps({ bands, navy, tw, th, wallH, bottomRow });
//   p.floor[kind][band]      -> { canvas, w, h, anchorX, anchorY, frames? }  (frames are the same shape)
//   p.wall[kind].L[band]     -> same, a TW x (TH+wallH) canvas to draw at the wall tile's origin
//   p.wall[kind].R[band]     -> the mirrored right face
//   p.meta[kind]             -> { frameMs, glow, w, h } for decor (glow in front-view art coords)
//
// bands: number of light bands. navy: [r, g, b] cold stone target of band 0. tw/th/wallH/bottomRow:
// the iso tile geometry of app.js (bottomRow(px) = floor line of the face's column px).

const loadArt = (path, name) =>
  import(path).then((m) => m[name] ?? {}).catch((err) => {
    console.warn(`${path} unavailable, skipping that art:`, err);
    return {};
  });

const rows = (g) => (typeof g === 'string' ? g.split('\n') : g);

function parseColor(h) {
  if (typeof h !== 'string' || h[0] !== '#') return null;
  if (h.length === 4) h = `#${h[1]}${h[1]}${h[2]}${h[2]}${h[3]}${h[3]}`;
  if (h.length < 7) return null;
  return [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
}

// Palette char -> [r, g, b] for one band: non-emissive colours drift toward the cold navy
// stone as the band gets darker (top band = authored colours).
function bandPalette(def, band, bands, navy) {
  const t = band / (bands - 1), keep = .3 + .7 * t;
  const emissive = new Set(def.emissive ?? []);
  const out = {};
  for (const [ch, hex] of Object.entries(def.palette ?? {})) {
    const c = parseColor(hex);
    if (!c) continue;
    out[ch] = emissive.has(ch) || keep >= 1 ? c : c.map((v, i) => Math.round(navy[i] + (v - navy[i]) * keep));
  }
  return out;
}

const make = (w, h) => Object.assign(document.createElement('canvas'), { width: w, height: h });
const put = (g, x, y, [r, gg, b]) => {
  g.fillStyle = `rgb(${r},${gg},${b})`;
  g.fillRect(x, y, 1, 1);
};

// One front-view frame -> floor sprite canvas.
function floorFrame(grid, pal) {
  const gr = rows(grid), w = Math.max(...gr.map((r) => r.length)), h = gr.length;
  const c = make(w, h), g = c.getContext('2d');
  gr.forEach((row, y) => [...row].forEach((ch, x) => pal[ch] && put(g, x, y, pal[ch])));
  return c;
}

// One front-view frame -> the face canvas: column c lands on face column 1 + c, shifted down
// floor(px / 2) (the face slopes half a pixel per column); its bottom row sits on the face's
// floor line, bottomRow(px) + wallH. 'R' mirrors the result across the tile.
function faceFrame(grid, pal, side, { tw, th, wallH, bottomRow }) {
  const gr = rows(grid), h = gr.length;
  const c = make(tw, th + wallH), g = c.getContext('2d');
  gr.forEach((row, r) => [...row].forEach((ch, col) => {
    if (!pal[ch]) return;
    const px = 1 + col, y = bottomRow(px) + wallH - (h - 1 - r);
    if (px >= tw / 2 || y < 0) return;
    put(g, side === 'L' ? px : tw - 1 - px, y, pal[ch]);
  }));
  return c;
}

const sprite = (frames, w, h, anchorX, anchorY) =>
  ({ canvas: frames[0], w, h, anchorX, anchorY, ...(frames.length > 1 ? { frames: frames.map((canvas) => ({ canvas, w, h, anchorX, anchorY })) } : {}) });

export async function buildProps({ bands, navy, tw, th, wallH, bottomRow }) {
  const [FLOOR_ART, WALL_ART] = await Promise.all([
    loadArt('./floor-art.js', 'FLOOR_ART'),
    loadArt('./wall-art.js', 'WALL_ART'),
  ]);
  const geom = { tw, th, wallH, bottomRow };
  const out = { floor: {}, wall: {}, meta: {} };

  for (const [kind, def] of Object.entries(FLOOR_ART)) {
    if (!def?.frames?.length) continue;
    const gr = rows(def.frames[0]), w = Math.max(...gr.map((r) => r.length)), h = gr.length;
    out.floor[kind] = Array.from({ length: bands }, (_, band) => {
      const pal = bandPalette(def, band, bands, navy);
      return sprite(def.frames.map((f) => floorFrame(f, pal)), w, h, def.anchorX ?? w >> 1, def.anchorY ?? h - 1);
    });
  }

  for (const [kind, def] of Object.entries(WALL_ART)) {
    if (!def?.frames?.length) continue;
    const h = rows(def.frames[0]).length;
    const w = Math.max(...rows(def.frames[0]).map((r) => r.length));
    const sides = { L: [], R: [] };
    for (let band = 0; band < bands; band++) {
      const pal = bandPalette(def, band, bands, navy);
      for (const side of ['L', 'R']) {
        sides[side].push(sprite(def.frames.map((f) => faceFrame(f, pal, side, geom)), tw, th + wallH, 0, 0));
      }
    }
    out.wall[kind] = sides;
    out.meta[kind] = { frameMs: def.frameMs ?? 260, glow: def.glow ?? null, w, h };
  }
  return out;
}
