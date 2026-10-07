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
  o: '#1e0f05', // outline
  k: '#2d1608', // shelf interior / deep shadow
  w: '#603312', // dark wood
  W: '#93531f', // wood
  L: '#c4782e', // wood light
  h: '#df9b4a', // wood highlight
  s: '#3c5476', // iron shade
  S: '#708eb2', // iron (blue-grey)
  t: '#aec4dc', // iron highlight
  c: '#844530', // clay
  C: '#ad6242', // clay light
  d: '#54291c', // clay dark
  b: '#1f2c61', // dark blue
  B: '#344994', // blue
  n: '#657fce', // blue highlight
  a: '#c49e56', // sack light
  A: '#957437', // sack
  Z: '#634c25', // sack shade
  y: '#d5a73e', // grain
  g: '#51987a', // glass bottle
  G: '#85c9a8', // glass highlight
};

const BONE_PAL = {
  o: '#181a28', // outline
  e: '#e3daa7', // bone
  E: '#b6a96e', // bone shade
  k: '#13131f', // eye socket
  h: '#f4eecb', // bone highlight
};

const STEEL_PAL = {
  o: '#172531', // outline
  D: '#3f5b6f', // dark steel
  M: '#6f8fa5', // mid steel
  L: '#abbfce', // light steel
  W: '#edf3f7', // highlight
  w: '#603312', // dark wood
  H: '#93531f', // wood
  l: '#c4782e', // wood light
  r: '#932121', // fletching dark
  R: '#d11920', // fletching
  f: '#dfd6ae', // feather
};

const POT_PAL = {
  o: '#1e0f05', // outline
  c: '#844530', // clay
  C: '#ad6242', // clay light
  d: '#54291c', // clay dark
  b: '#1f2c61', // dark blue
  B: '#344994', // blue
  n: '#657fce', // blue highlight
  v: '#131a3c', // blue deep shade
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
  merge(layer, oc, shadowOnly = false) {
    for (let y = -1; y <= layer.h; y++) for (let x = -1; x <= layer.w; x++) {
      if (layer.get(x, y) !== '.') continue;
      if (shadowOnly) { if (layer.get(x, y - 1) !== '.') this.set(x, y, oc); continue; }
      if (layer.get(x - 1, y) !== '.' || layer.get(x + 1, y) !== '.' ||
          layer.get(x, y - 1) !== '.' || layer.get(x, y + 1) !== '.') this.set(x, y, oc);
    }
    for (let y = 0; y < layer.h; y++) for (let x = 0; x < layer.w; x++) {
      if (layer.p[y][x] !== '.') this.p[y][x] = layer.p[y][x];
    }
  }
  // The rows inside [x0, x1) x [y0, y1) (a crop shared by several frames).
  cropTo(x0, y0, x1, y1) { return this.p.slice(y0, y1).map((r) => r.slice(x0, x1).join('')); }
  bounds() {
    const { rows, x0, y0 } = this.crop();
    return { x0, y0, x1: x0 + (rows[0]?.length ?? 0), y1: y0 + rows.length };
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
function box(L, u0, w0, a, b, z0, h, cols, [ox, oy] = [X0, Y0]) {
  const fx = ox + u0 + a - w0 - b;
  const fy = oy + ((u0 + a + w0 + b) >> 1) - z0;
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
  const a = new Layer(CW, CH); crate(a, 0, 0, 10, 10, 0, 9, false); L.merge(a, 'o');
  const b = new Layer(CW, CH); crate(b, 1, 1, 8, 8, 9, 6, true); L.merge(b, 'o');
  const c = new Layer(CW, CH);
  // barrel to the right of the stack: footprint centre u=12.5, w=4.5
  const cx = X0 + 8, cyb = Y0 + 8 + 3;
  barrel(c, cx, cyb, 4, 2, 9, [2, 6]);
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
  vase(o1, 14, 15, [4, 2, 2, 5, 6, 6, 5, 3], 'c', 'C', 'd', 'C'); // tall clay, back
  L.merge(o1, 'o');
  const o2 = new Layer(36, 28);
  vase(o2, 8, 19, [4, 2, 2, 4, 6, 6, 5, 3], 'B', 'n', 'v', 'n'); // dark blue, front left
  L.merge(o2, 'o');
  const o3 = new Layer(36, 28);
  vase(o3, 19, 19, [3, 2, 4, 5, 5, 3], 'c', 'C', 'd', null); // small clay, front right
  L.merge(o3, 'o');
  const { rows, x0, y0 } = L.crop();
  return { palette: POT_PAL, frames: [rows], anchorX: 14 - x0, anchorY: 17 - y0, emissive: [] };
}

// ------------------------------------------------------------------ skull
function makeSkull() {
  const L = new Layer(32, 24);
  const b1 = new Layer(32, 24); // bone along "/"
  b1.line(2, 15, 10, 11, 'e'); b1.set(2, 14, 'e'); b1.set(1, 15, 'E'); b1.set(3, 16, 'E'); b1.set(11, 10, 'e'); b1.set(11, 11, 'E');
  L.merge(b1, 'o', true);
  const b2 = new Layer(32, 24); // bone along "\"
  b2.line(12, 13, 19, 16, 'e'); b2.set(12, 12, 'e'); b2.set(11, 13, 'E'); b2.set(19, 17, 'E'); b2.set(20, 16, 'e');
  L.merge(b2, 'o', true);
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
  sh.line(5, 13, 16, 8, 'H'); sh.line(5, 14, 16, 9, 'w');
  for (const [x, y] of [[16, 6], [17, 7], [18, 7]]) sh.set(x, y, 'l'); sh.set(17, 8, 'l'); sh.set(15, 7, 'l'); // grip
  for (const [x, y, c] of [[1, 14, 'D'], [2, 13, 'M'], [2, 14, 'L'], [2, 15, 'D'], [3, 12, 'L'], [3, 13, 'L'], [3, 14, 'M'], [3, 15, 'D'], [4, 13, 'M'], [4, 14, 'M'], [4, 15, 'D'], [1, 15, 'D']]) sh.set(x, y, c);
  L.merge(sh, 'o', true);
  // pickaxe along "\" (head upper left, handle down right)
  const pk = new Layer(32, 24);
  pk.line(6, 5, 19, 11, 'H'); pk.line(6, 6, 19, 12, 'w');
  pk.set(20, 11, 'l'); pk.set(20, 12, 'l');
  pk.line(3, 8, 11, 4, 'M'); pk.line(4, 8, 10, 5, 'D');
  pk.set(2, 8, 'L'); pk.set(3, 7, 'L'); pk.set(12, 3, 'L'); pk.set(11, 3, 'W'); pk.set(2, 9, 'M'); pk.set(12, 4, 'M');
  pk.set(7, 5, 'L'); pk.set(8, 4, 'W');
  L.merge(pk, 'o', true);
  const { rows, x0, y0 } = L.crop();
  return { palette: STEEL_PAL, frames: [rows], anchorX: 10 - x0, anchorY: 9 - y0, emissive: [] };
}

// ------------------------------------------------------------------ sword
function makeSword() {
  const L = new Layer(32, 24);
  // arrow along "\" in the upper left (fletching left, head right)
  const ar = new Layer(32, 24);
  ar.line(3, 3, 12, 7, 'H');
  ar.set(13, 8, 'L'); ar.set(14, 8, 'M'); ar.set(13, 7, 'M');
  ar.set(1, 2, 'r'); ar.set(2, 2, 'R'); ar.set(2, 3, 'f'); ar.set(3, 2, 'R'); ar.set(2, 4, 'R'); ar.set(3, 4, 'r'); ar.set(1, 3, 'r');
  L.merge(ar, 'o', true);
  // sword along "/": pommel lower-left, tip upper-right
  const sw = new Layer(32, 24);
  const dy = -1;
  const S = (x, y, c) => sw.set(x, y + dy, c);
  S(2, 14, 'l'); S(2, 15, 'l'); S(3, 15, 'l');
  sw.line(3, 14 + dy, 6, 12 + dy, 'H');
  for (const [x, y] of [[5, 9], [6, 10], [7, 11], [8, 12], [9, 13]]) S(x, y, 'M');
  S(4, 9, 'L'); S(10, 13, 'L');
  sw.line(8, 11 + dy, 19, 6 + dy, 'W'); sw.line(8, 12 + dy, 19, 7 + dy, 'L');
  S(20, 5, 'W'); S(20, 6, 'L');
  L.merge(sw, 'o', true);
  const { rows, x0, y0 } = L.crop();
  return { palette: STEEL_PAL, frames: [rows], anchorX: 11 - x0, anchorY: 10 - y0, emissive: [] };
}

// ------------------------------------------------------------------ anvil / goblet / fountain / forge
// (added later: small anvil + goblet, solid fountain + forge. `glow` / `frameMs` are read by buildProps
// (floorMeta) and drawn like the torch glow; glow x, y are in sprite pixels, mirrored with the sprite.)
const padRows = (rows) => { const w = Math.max(...rows.map((r) => r.length)); return rows.map((r) => r.padEnd(w, '.')); };
const withRows2 = (base, rows) => base.map((r, i) => (i in rows ? rows[i] : r));

const ANVIL_PAL = {
  o: '#1b1223', D: '#3b4660', M: '#6b7c99', L: '#a9b8d0', W: '#e9eef7',
};
const ANVIL = padRows([
  '....oooooooooo....',
  '..oooWWLLLLLLLoo..',
  'oooLLLLMMMMMMMMDoo',
  'oLLMMMMMMMMMMMDDDo',
  '.ooMMMMMMMMMMDDDo.',
  '...oooMMMMMMDDoo..',
  '......oMMMMDDo....',
  '......oMMMMDDo....',
  '.....oMMMMMDDDo...',
  '...ooMMMMMMMDDDoo.',
  '..oLLMMMMMMMMDDDo.',
  '..oooooooooooooooo',
]);

const GOBLET_PAL = {
  o: '#1b1223', S: '#9983b3', s: '#745d92', d: '#4b3b62', k: '#16102a',
  R: '#1f4fd0', O: '#3f8cff', y: '#9fdcff', h: '#e8f9ff',
};
const GOBLET_BASE = padRows([
  '............',
  '............',
  '............',
  '............',
  '............',
  '.oSSSSSSSdo.',
  'oSssssssssdo',
  'oSssssssssdo',
  '.oSsssssddo.',
  '..ooSsssdoo.',
  '....oSsdo...',
  '....oSsdo...',
  '...oSssddo..',
  '..oSSsssddo.',
  '.oSssssssdo.',
  '.oooooooooo.',
]);
const GOBLET_FRAMES = [
  withRows2(GOBLET_BASE, { 0: '.....R......', 1: '....ROR.....', 2: '...ROyOR.R..', 3: '...OyhyORO..', 4: '..ROyhhyOR..' }),
  withRows2(GOBLET_BASE, { 0: '......R.....', 1: '.....ROR....', 2: '..R.ROyOR...', 3: '..ROyhyyO...', 4: '..ROyhhyOR..' }),
  withRows2(GOBLET_BASE, { 0: '............', 1: '....R.R.....', 2: '...ROROR....', 3: '..ROyhyOR.R.', 4: '..ROyhhyOR..' }),
];

// ---- ellipse painters for the fountain
function ell(L, cx, cy, rx, ry, c) {
  for (let y = -ry; y <= ry; y++) {
    const w = Math.round(rx * Math.sqrt(1 - (y * y) / ((ry + 0.5) * (ry + 0.5))));
    for (let x = -w; x <= w; x++) L.set(cx + x, cy + y, c);
  }
}
const FOUNTAIN_PAL = {
  o: '#1b1223', S: '#9983b3', s: '#745d92', d: '#4b3b62',
  b: '#1f3f9a', B: '#2f6fe0', n: '#58a6ff', w: '#c6ecff', R: '#1f4fd0',
};
function makeFountain() {
  const frames = [0, 1, 2].map((f) => {
    const L = new Layer(32, 32);
    const o = new Layer(32, 32);
    // basin: rim wall, rim top, water
    ell(o, 14, 25, 13, 6, 'd'); for (let y = 21; y <= 25; y++) ell(o, 14, y, 13, 6, 's');
    ell(o, 14, 21, 13, 6, 'S'); ell(o, 14, 21, 11, 5, 'd'); ell(o, 14, 21, 10, 4, 'B');
    for (let x = 6; x <= 22; x += 3) o.set(x + (f % 2), 22 + (x % 2), 'n');
    o.set(5 + f * 2, 20, 'w'); o.set(22 - f * 2, 22, 'w');
    // pedestal and upper bowl
    for (let y = 11; y <= 20; y++) for (let x = 12; x <= 16; x++) o.set(x, y, x === 12 ? 'S' : x >= 15 ? 'd' : 's');
    ell(o, 14, 10, 7, 3, 'S'); ell(o, 14, 10, 6, 2, 'd'); ell(o, 14, 10, 5, 2, 'B');
    o.set(11 + f, 10, 'w'); o.set(16 - f, 11, 'n');
    // spout and water arcs falling into the bowls (animated)
    for (const [x, y] of [[14, 4], [14, 5], [14, 6], [14, 7], [14, 8]]) o.set(x, y, 'n');
    o.set(13, 5, f === 1 ? 'w' : 'n'); o.set(14, 3, f === 2 ? 'n' : 'w');
    for (const sx of [-1, 1]) {
      const pts = [[2, 5], [3, 4], [4, 4], [5, 5], [6, 7], [7, 9]];
      pts.forEach(([dx, y], i) => o.set(14 + sx * dx, y + 0, (i + f) % 3 === 0 ? 'w' : 'n'));
    }
    for (const sx of [-1, 1]) for (const [dx, y] of [[8, 13], [9, 15], [9, 17], [10, 19]]) o.set(14 + sx * dx, y, ((dx + f) % 3 === 0) ? 'w' : 'n');
    L.merge(o, 'o');
    return L.crop();
  });
  const { x0, y0 } = frames[0];
  return { palette: FOUNTAIN_PAL, frames: frames.map((c) => c.rows), anchorX: 14 - x0, anchorY: 21 - y0,
    emissive: ['n', 'w', 'B'], glow: { x: 14 - x0, y: 9 - y0, radius: 26, color: '#4aa3ff' } };
}

// ---- forge: ONE big brick furnace over a block of cells. makeForge(ca, cb): the art's left face runs ca cells
// (16 art px each) along the art's u axis, its right face cb cells; the fire mouth is on the left face, the
// bellows on the plinth beside the furnace. Built for 2x2, 2x3 and 3x2; a world footprint wx x wy with flip:false
// uses forge_<wx>x<wy>, with flip:true the mirror image forge_<wy>x<wx>. The renderer cuts the sprite into one 16 px
// strip per footprint cell along its front (see drawForgeStrips in app.js), so `anchorX/anchorY` is the footprint's
// top vertex (the back corner), and `glow` sits at the fire mouth.
const FORGE_PAL = {
  o: '#1e1608', b: '#a3976a', m: '#7d7149', n: '#53492f', k: '#120a05',
  c: '#ff5a1a', R: '#e74a0e', O: '#ff9a2e', y: '#ffe27a', h: '#fff6c8',
  w: '#603312', W: '#93531f', L: '#c4782e', t: '#aec4dc',
};
function makeForge(ca, cb) {
  const PLA = 16 * ca, PLB = 16 * cb;
  const W2 = 16 * (ca + cb) + 28, H2 = 8 * (ca + cb) + 110;
  const org = [16 * cb + 14, 100];
  const bodyU = ca >= 3 ? 16 * (ca - 1) - 4 : 22, bodyW = Math.min(16 * cb - 14, 32), HB = 18;
  const mw = Math.min(bodyU - 6, 16); // fire mouth width
  const mk = (f) => {
    const o = new Layer(W2, H2);
    const bx = (u0, w0, a, b, z0, h, cols) => box(o, u0, w0, a, b, z0, h, cols, org);
    const px = (u, w, z) => [org[0] + u - w, org[1] + ((u + w) >> 1) - z];
    const courses = (bb, len, wid, h, step) => {
      for (let v = 2; v < h; v += step) {
        for (let u = 0; u < len; u++) { const [x, y] = bb.lf(u, v); o.set(x, y, 'n'); }
        for (let s2 = 0; s2 < wid; s2++) { const [x, y] = bb.rf(s2, v); o.set(x, y, 'k'); }
      }
    };
    // plinth the whole footprint wide, then the furnace body on it
    bx(1, 1, PLA - 2, PLB - 2, 0, 5, { top: 'm', topEdge: 'b', left: 'b', right: 'n' });
    const body = bx(3, 4, bodyU, bodyW, 5, HB, { top: 'b', topEdge: 'b', left: 'm', right: 'n' });
    courses(body, bodyU, bodyW, HB, 4);
    for (let v = 0; v < HB; v += 4) for (let u = 1 + (v % 8 ? 2 : 0); u < bodyU; u += 5) { const [x, y] = body.lf(u, v + 1); o.set(x, y, 'n'); }
    // two narrower tiers and a dark flue
    const s1 = Math.min(bodyU, bodyW) - 4, s2 = s1 - 6;
    const cu = 3 + bodyU / 2, cw = 4 + bodyW / 2;
    const t1 = bx(Math.round(cu - s1 / 2), Math.round(cw - s1 / 2), s1, s1, 5 + HB, 11, { top: 'b', topEdge: 'b', left: 'm', right: 'n' });
    courses(t1, s1, s1, 11, 4);
    const t2 = bx(Math.round(cu - s2 / 2), Math.round(cw - s2 / 2), s2, s2, 5 + HB + 11, 9, { top: 'b', topEdge: 'b', left: 'm', right: 'n' });
    courses(t2, s2, s2, 9, 4);
    ell(o, t2.fx, t2.fy - 9 - (s2 >> 1), (s2 >> 1) - 1, Math.max(1, (s2 >> 2) - 1), 'n');
    ell(o, t2.fx, t2.fy - 9 - (s2 >> 1), (s2 >> 1) - 3, Math.max(1, (s2 >> 2) - 2), 'k');
    // fire mouth on the left face: dark opening, flames from the bottom, embers on the floor of it
    const m0 = (bodyU - mw) >> 1;
    for (let u = m0; u < m0 + mw; u++) for (let v = 1; v <= 14; v++) { const [x, y] = body.lf(u, v); o.set(x, y, 'k'); }
    for (let i = 0; i < mw; i++) {
      const mid = 1 - Math.abs(i - (mw - 1) / 2) / (mw / 2);
      const hf = Math.min(13, 4 + Math.round(6 * mid) + ((i * 5 + f * 3 + (i >> 1)) % 4));
      for (let r = 0; r < hf; r++) {
        const d = hf - 1 - r;
        const col = d === 0 ? 'R' : d === 1 ? 'O' : d === 2 || r > 2 ? 'y' : 'h';
        const [x, y] = body.lf(m0 + i, 1 + r); o.set(x, y, r === 0 ? ((i + f) % 2 ? 'c' : 'R') : col);
      }
    }
    for (let u = m0 - 1; u <= m0 + mw; u++) { const [x, y] = body.lf(u, 15); o.set(x, y, 'b'); const [x2, y2] = body.lf(u, 0); o.set(x2, y2, 'o'); }
    // 3-wide: beside the furnace; 2-wide: on the front of the plinth, to the right of the mouth's embers
    const beside = ca >= 3;
    const bu0 = beside ? 16 * (ca - 1) + 1 : PLA - 2 - 11, bA = PLA - 2 - bu0;
    const bw0 = beside ? 6 : 4 + bodyW + 2, bB = beside ? Math.min(PLB - 16, 20) : PLB - 2 - bw0;
    // embers on the hearth in front of the mouth
    for (let u = m0; u < Math.min(m0 + mw, bu0 - 4); u += 2) {
      const [x, y] = px(3 + u, 4 + bodyW + 1 + ((u + f) % 3 === 0 ? 1 : 0), 5);
      o.set(x, y, (u + f) % 4 === 0 ? 'c' : 'R'); o.set(x, y + 1, 'k');
    }
    // bellows beside the furnace on the plinth: leather wedge, wooden handle and nozzle
    const bel = bx(bu0, bw0, bA, bB, 5, 5, { top: 'L', topEdge: 'L', left: 'W', right: 'w' });
    const cx = bel.fx + ((bB - bA) >> 1), cy = bel.fy - 5 - ((bA + bB) >> 2);
    o.line(cx, cy, cx + 8, cy - 5, 'W'); o.line(cx, cy + 1, cx + 8, cy - 4, 'w');
    o.line(bel.fx - bA + 1, bel.fy - (bA >> 1) - 3, bel.fx - bA - 3, bel.fy - (bA >> 1) - 1, 'w');
    const L = new Layer(W2, H2);
    L.merge(o, 'o');
    const mouth = body.lf(m0 + (mw >> 1), 6);
    return { L, mouth };
  };
  const frames = [0, 1, 2].map(mk);
  const bs = frames.map((fr) => fr.L.bounds());
  const x0 = Math.min(...bs.map((q) => q.x0)), y0 = Math.min(...bs.map((q) => q.y0));
  const x1 = Math.max(...bs.map((q) => q.x1)), y1 = Math.max(...bs.map((q) => q.y1));
  const [mx, my] = frames[0].mouth;
  return { palette: FORGE_PAL, frames: frames.map((fr) => fr.L.cropTo(x0, y0, x1, y1)), anchorX: org[0] - x0, anchorY: org[1] - y0,
    emissive: ['c', 'R', 'O', 'y', 'h'], glow: { x: mx - x0, y: my - y0, radius: 14 + 5 * (ca + cb), color: '#ff8a2a' } };
}

export const FLOOR_ART = {
  shelf: makeShelf(),
  crates: makeCrates(),
  storage_chest: makeChest(),
  pots: makePots(),
  skull: makeSkull(),
  tools: makeTools(),
  sword: makeSword(),
  anvil: { palette: ANVIL_PAL, frames: [ANVIL], anchorX: 9, anchorY: 8, emissive: [] },
  goblet: { palette: GOBLET_PAL, frames: GOBLET_FRAMES, anchorX: 6, anchorY: 13, emissive: ['R', 'O', 'y', 'h'],
    glow: { x: 6, y: 4, radius: 18, color: '#4aa3ff' } },
  fountain: makeFountain(),
  // the forge is one big sprite per footprint shape (see makeForge); there is no one-cell forge art
  forge_2x2: makeForge(2, 2),
  forge_2x3: makeForge(2, 3),
  forge_3x2: makeForge(3, 2),
};
