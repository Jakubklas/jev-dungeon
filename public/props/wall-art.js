// Wall decor pixel art (CONTRACT.md, "v4: props and wall decor").
// Flat FRONT view string grids ('.' = transparent); the renderer shears them
// onto an iso wall face. DOM-free so it can be validated / previewed in node.
// Bottom row sits on the floor line; width <= 14, height <= 19.

// Replace whole rows of a base grid to make animation frames.
const withRows = (base, rows) => base.map((r, i) => (i in rows ? rows[i] : r));

// ---------------------------------------------------------------- torch 5x10
const TORCH_PAL = {
  o: '#1b1520', // outline
  i: '#4a4350', // dark iron
  I: '#7d7488', // iron highlight
  R: '#d9501c', // flame edge (red-orange)
  O: '#ff9a2e', // flame orange
  y: '#ffe27a', // flame core
  w: '#fff6c8', // hot centre
};
const TORCH_A = [
  '..R..',
  '.ROR.',
  '.OyO.',
  '.OwO.',
  '.ROR.',
  'oIiIo',
  '.oIo.',
  '..i..',
  '..i..',
  '.oio.',
];
const TORCH_FRAMES = [
  TORCH_A,
  withRows(TORCH_A, { 0: '.R...', 1: '.ROR.', 2: '.OyOR', 3: '.OwO.' }),
  withRows(TORCH_A, { 0: '...R.', 1: '.ROR.', 2: 'ROyO.', 3: '.OwO.' }),
  withRows(TORCH_A, { 0: '..R..', 1: '.ROR.', 2: '.OyO.', 3: '.OyO.', 4: '..O..' }),
];

// ---------------------------------------------------------------- fireplace 14x17
const FIRE_PAL = {
  o: '#1b1520', // outline
  S: '#9a90a6', // stone light
  s: '#766d82', // stone
  d: '#4d4558', // stone shade
  k: '#150a0a', // firebox dark
  b: '#3a1a12', // firebox brick, warm-lit
  W: '#8a5428', // log
  w: '#5a3418', // log dark
  c: '#ff5a1a', // coals
  R: '#d9501c', // flame edge
  O: '#ff9a2e', // flame orange
  y: '#ffe27a', // flame core
  h: '#fff6c8', // hot centre
};
const FIRE_BASE = [
  '....oooooo....',
  '....oSssdo....',
  '....oSssdo....',
  '...oSsssddo...',
  '...oSsssddo...',
  '..oSssssssdo..',
  '..oSssssssdo..',
  '.oooooooooooo.',
  'oSSSSSSSSSSSSo',
  'osssssssssssdo',
  'oSsoooooooosdo',
  'oSskbbbbbbksdo',
  'oSsbbbbbbbbsdo',
  'oSsbbbbbbbbsdo',
  'oSsbbbbbbbbsdo',
  'oSsWwcwcwWbsdo',
  'oSSSSSSSSSSSSo',
];
// opening is columns 3..10 (8 wide), rows 11..15
const fireFrame = (rows) => withRows(FIRE_BASE, Object.fromEntries(
  rows.map((r, i) => [11 + i, 'oSs' + r + 'sdo'])));
const FIRE_FRAMES = [
  fireFrame(['bbbRbbbb', 'bbROyRbb', 'bRyhyORb', 'bOyhhyOb', 'wWOcycWw']),
  fireFrame(['bbbbRbbb', 'bbbRORbb', 'bROyyORb', 'bOyhyyOb', 'wWcOycWw']),
  fireFrame(['bbRbbbbb', 'bbORyRbb', 'bRyyhyRb', 'bOhhyyOb', 'wWOyccWw']),
];

// ---------------------------------------------------------------- arch 14x14
const ARCH_PAL = {
  o: '#1b1520', // outline
  S: '#9a90a6', // stone light
  s: '#766d82', // stone
  d: '#4d4558', // stone shade
  k: '#0b0710', // dark opening
  K: '#171221', // opening edge shade
};
const ARCH = [
  '....oSSSSo....',
  '..ooSsssddoo..',
  '.oSsddddddsdo.',
  'oSsdkkkkkkdsdo',
  'oSSokkkkkkoSSo',
  'oSdokkkkkkoSdo',
  'oSdokkkkkkoSdo',
  'oSdokkkkkkoSdo',
  'oSdokkkkkkoSdo',
  'oSdokkkkkkoSdo',
  'oSdokkkkkkoSdo',
  'oSSokkkkkkoSSo',
  'oSSokkkkkkoSSo',
  'oSSSkkkkkkSSSo',
];

// ---------------------------------------------------------------- gate 12x13
const GATE_PAL = {
  o: '#1b1520', // outline
  S: '#9a90a6', // stone light
  s: '#766d82', // stone
  d: '#4d4558', // stone shade
  i: '#3d3846', // iron bars
  I: '#625b6e', // bar highlight
  k: '#2a140c', // dark behind
  O: '#ff9a2e', // warm light
  y: '#ffd266', // bright light
  R: '#c4561c', // dim warm light
};
const GATE_A = [
  '...oSSSSo...',
  '..oSssssdo..',
  '.oSsiIiIsdo.',
  '.oSdOiOiOsdo',
  '.oSdRiyiRsdo',
  '.oSdOiOiOsdo',
  '.oSdyiOiysdo',
  '.oSdOiyiOsdo',
  '.oSdRiOiRsdo',
  '.oSdOiOiOsdo',
  '.oSdRiRiRsdo',
  '.oiiiiiiiiio',
  'oSSSSSSSSSSo',
];
const GATE_FRAMES = [
  GATE_A,
  GATE_A.map((r) => r.replace(/[yOR]/g, (c) => ({ y: 'O', O: 'y', R: 'O' }[c]))),
  GATE_A.map((r) => r.replace(/[yOR]/g, (c) => ({ y: 'O', O: 'R', R: 'k' }[c]))),
];

export const WALL_ART = {
  torch: {
    palette: TORCH_PAL, frames: TORCH_FRAMES, frameMs: 130,
    glow: { x: 2, y: 3, radius: 22, color: '#ffa43c' },
    emissive: ['R', 'O', 'y', 'w'],
  },
  fireplace: {
    palette: FIRE_PAL, frames: FIRE_FRAMES, frameMs: 150,
    glow: { x: 7, y: 13, radius: 34, color: '#ff8a2a' },
    emissive: ['c', 'R', 'O', 'y', 'h'],
  },
  arch: {
    palette: ARCH_PAL, frames: [ARCH], frameMs: 1000,
    glow: null,
    emissive: [],
  },
  gate: {
    palette: GATE_PAL, frames: GATE_FRAMES, frameMs: 200,
    glow: { x: 6, y: 7, radius: 16, color: '#ff9a3a' },
    emissive: ['O', 'y', 'R'],
  },
};
