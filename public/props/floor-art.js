// Floor props (CONTRACT.md, "v4: props and wall decor"): DOM-free string-grid art.
// Same format as public/sprites.js: one char per art pixel, '.' = transparent,
// one palette per kind. Solid props are authored for flip:false: backed onto a
// wall at the upper right of the cell (the "\" run of the diamond), front face
// toward the lower left. The renderer mirrors around anchorX for flip:true.
//
// The art is composed at import time from tiny helpers (iso boxes, barrels,
// vases, lines) in cell coordinates (u along "\", w = depth from the wall
// along "/", z = height; 16 art px per cell side), then cropped to its bounds.
// anchorX/anchorY = the pixel that lands on the cell centre (u=8, w=8, z=0).

const WOOD = {
  o: '#1c0f07', // outline
  k: '#2a170b', // shelf interior / deep shadow
  w: '#5a3418', // dark wood
  W: '#8a5428', // wood
  L: '#b8783a', // wood light
  h: '#d49a55', // wood highlight
  s: '#46566c', // iron shade
  S: '#7d8fa5', // iron (blue-grey)
  t: '#b4c4d6', // iron highlight
  c: '#7a4a3a', // clay
  C: '#a0674f', // clay light
  d: '#4e2c22', // clay dark
  b: '#26305a', // dark blue
  B: '#3e4f8a', // blue
  n: '#6f84c4', // blue highlight
  a: '#b89a62', // sack light
  A: '#8a7142', // sack
  Z: '#5c4a2c', // sack shade
  y: '#c9a24a', // grain
  g: '#5f8a78', // glass bottle
  G: '#8fbfa8', // glass highlight
};

const BONE_PAL = {
  o: '#1c1d24', // outline
  e: '#ddd6ad', // bone
  E: '#a9a17b', // bone shade
  k: '#16161c', // eye socket
  h: '#f1ecce', // bone highlight
};

const STEEL_PAL = {
  o: '#1b252d', // outline
  D: '#4a5964', // dark steel
  M: '#7f8c95', // mid steel
  L: '#b3bec6', // light steel
  W: '#eef3f6', // highlight
  w: '#5a3418', // dark wood
  H: '#8a5428', // wood
  l: '#b8783a', // wood light
  r: '#8a2a2a', // fletching dark
  R: '#c4262c', // fletching
  f: '#d9d2b4', // feather
};

const POT_PAL = {
  o: '#1c0f07', // outline
  c: '#7a4a3a', // clay
  C: '#a0674f', // clay light
  d: '#4e2c22', // clay dark
  b: '#26305a', // dark blue
  B: '#3e4f8a', // blue
  n: '#6f84c4', // blue highlight
  v: '#171d38', // blue deep shade
};

// ------------------------------------------------------------------ painter
class Layer {
  constructor(w, h) {
    this.w = w; this.h = h;
    this.p = Array.from({ length: h }, () => Array(w).fill('.'));
  }
  set(x, y, c) {
    x = Math.round(x); y = Math.round(y);
    if (x >= 0 && y >= 0 && x < this.w && y < this.h) this.p[y][x] = c;
  }
  get(x, y) { return x >= 0 && y >= 0 && x < this.w && y < this.h ? this.p[y][x] : '.'; }
  line(x0, y0, x1, y1, c) {
    x0 = Math.round(x0); y0 = Math.round(y0); x1 = Math.round(x1); y1 = Math.round(y1);
    const dx = Math.abs(x1 - x0), dy = -Math.abs(y1 - y0);
    const sx = x0 < x1 ? 1 : -1, sy = y0 < y1 ? 1 : -1;
    let err = dx + dy;
    for (;;) {
      this.set(x0, y0, c);
      if (x0 === x1 && y0 === y1) break;
      const e2 = 2 * err;
      if (e2 >= dy) { err += dy; x0 += sx; }
      if (e2 <= dx) { err += dx; y0 += sy; }
    }
  }
  // Stamp a small string grid with its bottom-centre at (cx, yb).
  stamp(rows, cx, yb) {
    const h = rows.length, w = rows[0].length;
    for (let r = 0; r < h; r++) for (let c = 0; c < w; c++) {
      const ch = rows[r][c];
      if (ch !== '.') this.set(cx - (w >> 1) + c, yb - (h - 1) + r, ch);
    }
  }
  // Composite `layer` onto this one with a 1px outer outline (4-neighbour).
  merge(layer, oc) {
    for (let y = -1; y <= layer.h; y++) for (let x = -1; x <= layer.w; x++) {
      if (layer.get(x, y) !== '.') continue;
      if (layer.get(x - 1, y) !== '.' || layer.get(x + 1, y) !== '.' ||
          layer.get(x, y - 1) !== '.' || layer.get(x, y + 1) !== '.') this.set(x, y, oc);
    }
    for (let y = 0; y < layer.h; y++) for (let x = 0; x < layer.w; x++) {
      if (layer.p[y][x] !== '.') this.p[y][x] = layer.p[y][x];
    }
  }
  crop() {
    let x0 = this.w, y0 = this.h, x1 = -1, y1 = -1;
    for (let y = 0; y < this.h; y++) for (let x = 0; x < this.w; x++) {
      if (this.p[y][x] !== '.') { x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y); }
    }
    return { rows: this.p.slice(y0, y1 + 1).map((r) => r.slice(x0, x1 + 1).join('')), x0, y0 };
  }
}

const CW = 48, CH = 56, X0 = 24, Y0 = 36; // canvas + cell top vertex (u=0,w=0)

// Iso box in cell coords. cols: { top, topEdge, left, right }.
function box(L, u0, w0, a, b, z0, h, cols) {
  const fx = X0 + u0 + a - w0 - b;
  const fy = Y0 + ((u0 + a + w0 + b) >> 1) - z0;
  const yL = (t) => fy - (a >> 1) + (t >> 1); // bottom row of left face at column t
  const yR = (s) => fy - 1 - (s >> 1); // bottom row of right face at column s
  for (let t = 0; t < a; t++) for (let r = 0; r < h; r++) L.set(fx - a + t, yL(t) - r, cols.left);
  for (let s = 0; s < b; s++) for (let r = 0; r < h; r++) L.set(fx + s, yR(s) - r, cols.right);
  const ytl = fy - (a >> 1) - h;
  const lx = fx - a;
  for (let x = lx; x < fx + b; x++) {
    const d = x - lx;
    const lower = (x < fx ? yL(d) : yR(x - fx)) - h;
    const yu = ytl - (Math.min(d, b) >> 1) + (Math.max(0, d - b) >> 1);
    for (let y = yu; y <= lower; y++) L.set(x, y, y === lower && cols.topEdge ? cols.topEdge : cols.top);
  }
  return {
    fx, fy, a, b, h,
    lf: (u, v) => [fx - a + u, yL(u) - v],
    rf: (s, v) => [fx + s, yR(s) - v],
  };
}

// Barrel: bottom-ellipse centre (cx, cyb), ellipse half-size hw x hh, height H.
function barrel(L, cx, cyb, hw, hh, H, bandsZ) {
  const ell = (dx) => Math.round(hh * Math.sqrt(Math.max(0, 1 - (dx * dx) / ((hw + 0.5) * (hw + 0.5)))));
  for (let dx = -hw; dx <= hw; dx++) {
    const e = ell(dx);
    const bulge = Math.abs(dx) === hw ? 1 : 0; // slightly narrower at the very rim
    for (let y = cyb - H - e; y <= cyb + e - bulge * 0; y++) {
      const lidLow = cyb - H + e;
      let c;
      if (y <= lidLow) {
        c = (y === cyb - H - e || Math.abs(dx) === hw) ? 'L' : 'W';
        if (y === lidLow && Math.abs(dx) < hw) c = 'w';
        if (Math.abs(dx) <= 1 && y === cyb - H) c = 'h';
      } else {
        c = dx <= -hw + 1 ? 'L' : dx < Math.floor(hw / 3) ? 'W' : 'w';
      }
      L.set(cx + dx, y, c);
    }
    for (const zb of bandsZ) {
      for (let k = 0; k < 2; k++) {
        const y = cyb - zb + e - k;
        if (y > cyb - H + e) L.set(cx + dx, y, dx < 0 ? 'S' : 's');
      }
    }
  }
}

// Vase from a list of widths (top row first), bottom row at yb.
function vase(L, cx, yb, widths, m, l, d, hi) {
  const n = widths.length;
  widths.forEach((w, i) => {
    const y = yb - (n - 1) + i;
    for (let k = 0; k < w; k++) {
      let c = m;
      if (k === 0 && w >= 3) c = l;
      else if (k === w - 1 && w >= 3) c = d;
      else if (k === w - 2 && w >= 5) c = d;
      if (i === 0) c = l;
      L.set(cx - (w >> 1) + k, y, c);
    }
  });
  if (hi) L.set(cx - 1, yb - 4, hi);
}

function finish(L, anchorU, anchorW, emissive = []) {
  const ax = X0 + anchorU - anchorW, ay = Y0 + ((anchorU + anchorW) >> 1);
  const { rows, x0, y0 } = L.crop();
  return { frames: [rows], anchorX: ax - x0, anchorY: ay - y0, emissive };
}

// ------------------------------------------------------------------- shelf
function makeShelf() {
  const L = new Layer(CW, CH), o = new Layer(CW, CH);
  const a = 16, b = 6, h = 17;
  const g = box(o, 0, 0, a, b, 0, h, { top: 'L', topEdge: 'h', left: 'w', right: 'W' });
  // right side panel: plank line + dark inner edge
  for (let s = 0; s < b; s++) { const [x, y] = g.rf(s, h - 1); o.set(x, y, 'L'); }
  for (let v = 0; v < h; v += 1) { const [x, y] = g.rf(0, v); o.set(x, y, 'w'); }
  // front uprights and boards
  for (let v = 0; v < h; v++) {
    for (const u of [0, 1, 14, 15]) { const [x, y] = g.lf(u, v); o.set(x, y, u === 0 || u === 14 ? 'L' : 'W'); }
  }
  for (const v of [0, 5, 10]) for (let u = 0; u < a; u++) {
    const [x, y] = g.lf(u, v); o.set(x, y, 'L');
    if (v > 0) { const [x2, y2] = g.lf(u, v - 1); o.set(x2, y2, 'k'); }
  }
  for (const v of [15, 16]) for (let u = 0; u < a; u++) { const [x, y] = g.lf(u, v); o.set(x, y, v === 16 ? 'h' : 'L'); }
  // goods: pixel-stamped at (u, tier base v)
  const at = (u, v) => g.lf(u, v);
  const JAR_C = ['.cc.', 'CcCd', 'Cccd', '.dd.'];
  const JAR_B = ['.bb.', 'nBBb', 'nBBb', '.bb.'];
  const JAR_T = ['.cc.', '.cc.', 'CccC', 'Ccdd', '.dd.'];
  const SACK = ['..AA..', '.aAAA.', 'aaAAAZ', 'aAAAZZ'];
  const BOTTLE = ['.g', '.g', 'gG', 'gg', 'gg'];
  const BOWL = ['.yyy.', 'WLLLW', '.www.'];
  const put = (rows, u, v) => { const [x, y] = at(u, v + 1); o.stamp(rows, x, y); };
  // tier 1 (v 1..4)
  put(SACK, 5, 0); put(JAR_C, 11, 0);
  // tier 2 (v 6..9)
  put(JAR_B, 4, 5); put(BOTTLE, 8, 5); put(JAR_B, 11, 5);
  // tier 3 (v 11..14)
  put(BOWL, 4, 10); put(JAR_T, 8, 10); put(BOWL, 12, 10);
  L.merge(o, 'o');
  return { palette: WOOD, ...finish(L, 8, 8) };
}

// ------------------------------------------------------------------ crates
function crate(L, u0, w0, a, b, z0, h, dark) {
  const cols = dark
    ? { top: 'W', topEdge: 'L', left: 'w', right: 'k' }
    : { top: 'L', topEdge: 'h', left: 'W', right: 'w' };
  const g = box(L, u0, w0, a, b, z0, h, cols);
  const frame = dark ? 'W' : 'L', plank = dark ? 'k' : 'w', rframe = dark ? 'w' : 'W';
  for (let u = 0; u < a; u++) for (let v = 0; v < h; v++) {
    const [x, y] = g.lf(u, v);
    if (u === 0 || u === a - 1 || v === 0 || v === h - 1) L.set(x, y, frame);
    else if (u % 3 === 0 && u < a - 2) L.set(x, y, plank);
  }
  for (let s = 0; s < b; s++) for (let v = 0; v < h; v++) {
    const [x, y] = g.rf(s, v);
    if (s === b - 1 || v === 0 || v === h - 1) L.set(x, y, rframe);
    else if (s === 0) L.set(x, y, plank);
  }
  return g;
}

function makeCrates() {
  const L = new Layer(CW, CH);
  const a = new Layer(CW, CH); crate(a, 0, 0, 10, 10, 0, 10, false); L.merge(a, 'o');
  const b = new Layer(CW, CH); crate(b, 1, 1, 8, 8, 10, 7, true); L.merge(b, 'o');
  const c = new Layer(CW, CH);
  // barrel to the right of the stack: footprint centre u=12.5, w=4.5
  const cx = X0 + 8, cyb = Y0 + 8 + 3;
  barrel(c, cx, cyb, 4, 2, 10, [2, 7]);
  L.merge(c, 'o');
  return { palette: WOOD, ...finish(L, 8, 8) };
}

// ----------------------------------------------------------- storage chest
function makeChest() {
  const L = new Layer(CW, CH), o = new Layer(CW, CH);
  const u0 = 1, w0 = 0, a = 14, b = 8;
  const body = box(o, u0, w0, a, b, 0, 6, { top: 'W', topEdge: 'L', left: 'W', right: 'w' });
  const lid = box(o, u0, w0, a, b, 6, 4, { top: 'L', topEdge: 'h', left: 'L', right: 'W' });
  const bandsU = [2, 10];
  for (const bu of bandsU) {
    for (let k = 0; k < 2; k++) {
      for (let v = 0; v < 6; v++) { const [x, y] = body.lf(bu + k, v); o.set(x, y, k ? 'S' : 't'); }
      for (let v = 0; v < 4; v++) { const [x, y] = lid.lf(bu + k, v); o.set(x, y, k ? 'S' : 't'); }
      // band continues over the lid top: along w
      for (let w = 0; w < b; w++) {
        const px = X0 + u0 + bu + k - (w0 + w), py = Y0 + ((u0 + bu + k + w0 + w) >> 1) - 10;
        o.set(px, py, k ? 'S' : 't');
      }
    }
  }
  for (const s of [3, 4]) for (let v = 0; v < 6; v++) { const [x, y] = body.rf(s, v); o.set(x, y, 's'); }
  for (const s of [3, 4]) for (let v = 0; v < 4; v++) { const [x, y] = lid.rf(s, v); o.set(x, y, 's'); }
  for (let u = 0; u < a; u++) { const [x, y] = body.lf(u, 5); if (!bandsU.some((bu) => u === bu || u === bu + 1)) o.set(x, y, 'w'); }
  for (let u = 0; u < a; u++) { const [x, y] = body.lf(u, 2); if (!bandsU.some((bu) => u === bu || u === bu + 1) && u > 0 && u < a - 1) o.set(x, y, 'w'); }
  // lock plate + keyhole on the front, between the bands
  for (let u = 6; u <= 7; u++) for (let v = 3; v <= 5; v++) { const [x, y] = body.lf(u, v); o.set(x, y, u === 6 ? 't' : 'S'); }
  { const [x, y] = body.lf(7, 4); o.set(x, y, 'k'); }
  // rivets at the corners
  for (const u of [0, 13]) { const [x, y] = body.lf(u, 1); o.set(x, y, 't'); }
  L.merge(o, 'o');
  return { palette: WOOD, ...finish(L, 8, 8) };
}

// ------------------------------------------------------------------- pots
function makePots() {
  const L = new Layer(36, 28);
  const o1 = new Layer(36, 28);
  vase(o1, 14, 15, [4, 2, 3, 5, 6, 6, 5, 3], 'c', 'C', 'd', 'C'); // tall clay, back
  L.merge(o1, 'o');
  const o2 = new Layer(36, 28);
  vase(o2, 9, 19, [3, 2, 3, 5, 7, 7, 5, 3], 'B', 'n', 'v', 'n'); // dark blue, front left
  L.merge(o2, 'o');
  const o3 = new Layer(36, 28);
  vase(o3, 19, 19, [3, 3, 5, 6, 6, 4], 'c', 'C', 'd', null); // small clay, front right
  L.merge(o3, 'o');
  const { rows, x0, y0 } = L.crop();
  return { palette: POT_PAL, frames: [rows], anchorX: 14 - x0, anchorY: 17 - y0, emissive: [] };
}

// ------------------------------------------------------------------ skull
function makeSkull() {
  const L = new Layer(32, 24);
  const b1 = new Layer(32, 24); // bone along "/"
  b1.line(2, 15, 10, 11, 'e'); b1.set(2, 14, 'e'); b1.set(1, 15, 'E'); b1.set(3, 16, 'E'); b1.set(11, 10, 'e'); b1.set(11, 11, 'E');
  L.merge(b1, 'o');
  const b2 = new Layer(32, 24); // bone along "\"
  b2.line(12, 13, 20, 17, 'e'); b2.set(12, 12, 'e'); b2.set(11, 13, 'E'); b2.set(20, 18, 'E'); b2.set(21, 17, 'e');
  L.merge(b2, 'o');
  const sk = new Layer(32, 24);
  const SKULL = [
    '.ehhee.',
    'eeeeeeE',
    'ekkekkE',
    'ekkekkE',
    'eeekeEE',
    '.eeeEE.',
    '.eoeoE.',
  ];
  sk.stamp(SKULL, 10, 14);
  L.merge(sk, 'o');
  const { rows, x0, y0 } = L.crop();
  return { palette: BONE_PAL, frames: [rows], anchorX: 11 - x0, anchorY: 13 - y0, emissive: [] };
}

// ------------------------------------------------------------------ tools
function makeTools() {
  const L = new Layer(32, 24);
  // shovel along "/" (blade lower left, handle up right)
  const sh = new Layer(32, 24);
  sh.line(5, 14, 17, 8, 'H'); sh.line(5, 15, 17, 9, 'w');
  for (const [x, y] of [[17, 6], [18, 7], [19, 7]]) sh.set(x, y, 'l'); sh.set(18, 8, 'l'); sh.set(16, 7, 'l'); // grip
  for (const [x, y, c] of [[1, 15, 'D'], [2, 14, 'M'], [2, 15, 'L'], [2, 16, 'D'], [3, 13, 'L'], [3, 14, 'L'], [3, 15, 'M'], [3, 16, 'D'], [4, 14, 'M'], [4, 15, 'M'], [4, 16, 'D'], [5, 16, 'D'], [1, 16, 'D']]) sh.set(x, y, c);
  L.merge(sh, 'o');
  // pickaxe along "\" (head upper left, handle down right)
  const pk = new Layer(32, 24);
  pk.line(6, 5, 20, 12, 'H'); pk.line(6, 6, 20, 13, 'w');
  pk.set(21, 12, 'l'); pk.set(21, 13, 'l');
  pk.line(3, 8, 11, 4, 'M'); pk.line(4, 8, 10, 5, 'D');
  pk.set(2, 8, 'L'); pk.set(3, 7, 'L'); pk.set(12, 3, 'L'); pk.set(11, 3, 'W'); pk.set(2, 9, 'M'); pk.set(12, 4, 'M');
  pk.set(7, 5, 'L'); pk.set(8, 4, 'W');
  L.merge(pk, 'o');
  const { rows, x0, y0 } = L.crop();
  return { palette: STEEL_PAL, frames: [rows], anchorX: 10 - x0, anchorY: 9 - y0, emissive: [] };
}

// ------------------------------------------------------------------ sword
function makeSword() {
  const L = new Layer(32, 24);
  // arrow lying alongside, along "/"
  const ar = new Layer(32, 24);
  ar.line(5, 18, 15, 13, 'H');
  ar.set(16, 12, 'L'); ar.set(17, 12, 'M'); ar.set(16, 13, 'M');
  ar.set(4, 18, 'f'); ar.set(4, 17, 'R'); ar.set(5, 17, 'R'); ar.set(3, 18, 'r'); ar.set(6, 19, 'R'); ar.set(5, 19, 'r');
  L.merge(ar, 'o');
  // sword along "/": pommel lower-left, tip upper-right
  const sw = new Layer(32, 24);
  sw.set(2, 14, 'l'); sw.set(2, 15, 'l'); sw.set(3, 15, 'l');
  sw.line(3, 14, 6, 12, 'H');
  for (const [x, y] of [[5, 9], [6, 10], [7, 11], [8, 12], [9, 13]]) sw.set(x, y, 'M');
  sw.set(4, 9, 'L'); sw.set(10, 13, 'L');
  sw.line(8, 11, 21, 5, 'W'); sw.line(8, 12, 21, 6, 'L'); sw.line(10, 13, 20, 8, 'M');
  sw.set(22, 4, 'W'); sw.set(22, 5, 'L');
  L.merge(sw, 'o');
  const { rows, x0, y0 } = L.crop();
  return { palette: STEEL_PAL, frames: [rows], anchorX: 11 - x0, anchorY: 12 - y0, emissive: [] };
}

export const FLOOR_ART = {
  shelf: makeShelf(),
  crates: makeCrates(),
  storage_chest: makeChest(),
  pots: makePots(),
  skull: makeSkull(),
  tools: makeTools(),
  sword: makeSword(),
};
