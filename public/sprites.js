// Pixel-art sprites for the isometric 8-bit look (CONTRACT.md, "Look (v3)").
// Art is authored as string grids (one char per art pixel, '.' = transparent)
// plus a palette per sprite, then rasterised onto offscreen canvases.
// All art faces RIGHT; the renderer mirrors around anchorX.

const KNIGHT_PAL = {
  o: '#172531', // dark slate outline
  k: '#080e14', // visor slit
  D: '#3f5b6f', // dark steel
  M: '#6f8fa5', // mid steel
  L: '#abbfce', // light steel
  W: '#edf3f7', // highlight
  r: '#750b0f', // dark red (cape shade)
  R: '#d11920', // red (plume, cape, belt)
};

const GHOST_PAL = {
  o: '#181a28', // outline
  d: '#414762', // dark cloth
  g: '#666f95', // cloth
  l: '#9aa1bc', // light cloth
  h: '#cacfde', // hood highlight
  b: '#e3daa7', // bone
  B: '#b6a96e', // bone shade
  k: '#13131f', // eye socket
  e: '#ff3b30', // glowing red eye
};

const CHEST_PAL = {
  o: '#1e0f05', // outline
  w: '#603312', // dark wood
  W: '#93531f', // wood
  L: '#c4782e', // lid highlight
  y: '#fec62c', // gold
  Y: '#b37e11', // dark gold
  k: '#150a03', // keyhole
};

// ---------------------------------------------------------------- knight 18x24
const KNIGHT_A = [
  '....ooo...........',
  '...oRRRoo.........',
  '.....orRRo........',
  '......orRooo......',
  '....ooWWLLLLoo....',
  '...oWWLLLLLLLMo...',
  '..oWLLLLLLLLLLMo..',
  '..oLLLLLLLLLLLMo..',
  '..oDDDDDDDDDDDDo..',
  '..oLLLLLLMkkkkko..',
  '..oLLLLLLMLDLDLo..',
  '..oMLLLLLMkkkkko..',
  '..ooMMMMMMMMMMoo..',
  '..oroWLLMDooooooo.',
  '..oRoLLMMDoWLLLMo.',
  '..oRRoLMMDoLLDLMo.',
  '..oRRoRRRRoLDDDMo.',
  '..oRRoDLMDoLLDLMo.',
  '..oRRrDLMDooLDMo..',
  '..oRRroDMDo.oMMo..',
  '..orrroLDLDo..oo..',
  '...oooDLoDLo......',
  '.....oDLLoDLLo....',
  '......orRooo......',
];

// Breathing frame: helmet + plume settle 1px (shoulder row tucked under the
// helmet) and the cape hem sways.
const KNIGHT_B = (() => {
  const g = ['..................', ...KNIGHT_A.slice(0, 13), ...KNIGHT_A.slice(14)];
  g[20] = '...orroLDLDo..oo..';
  g[21] = '....ooDLoDLo......';
  return g;
})();

// ----------------------------------------------------------------- ghost 18x20
const GHOST_TOP = [
  '........ooooo.....',
  '......ooggllloo...',
  '.....oggllllllho..',
  '....ogglllloooooo.',
  '...odgllllobbbbbBo',
  '..oddglllobbbbbbBo',
  '..oddglllBkkbbkko.',
  '.oddgglllbkebbkeo.',
  'oddoggllloBbbbkbBo',
  '.oodgglllloBoBoBo.',
  '..odggglllloooooo.',
  '.oddgggllllllgdo..',
];

const GHOST_A = [
  ...GHOST_TOP,
  'oddo.dggglllggdo..',
  '.oo.odgggllggddo..',
  'odddodggglgggddo..',
  '.ooo.odggggggdo...',
  '..oddodgggggddo...',
  '...oo.odgdgddo....',
  '......odo.odo.....',
  '.......o...o......',
];

const GHOST_B = [
  ...GHOST_TOP,
  '.odo.dggglllggdo..',
  'oddoodgggllggddo..',
  '.ooodggggglggddo..',
  'oddo.odggggggdo...',
  '.oo.oodgggggddo...',
  '....oodgdgddo.....',
  '.....odo.odo......',
  '......o...o.......',
];

// ----------------------------------------------------------------- chest 12x10
const CHEST_A = [
  '.oooooooooo.',
  'oLyLLLLLLyLo',
  'oWyWWWWWWyWo',
  'oWyWWWWWWyWo',
  'ooYooyyyoYoo',
  'owYwwykywYwo',
  'oWYWWyyyWYWo',
  'oWYWWWWWWYWo',
  'owYwwwwwwYwo',
  'oooooooooooo',
];

// Raw art data (DOM-free) so it can be validated / previewed in node.
export const ART = {
  knight: { palette: KNIGHT_PAL, frames: [KNIGHT_A, KNIGHT_B], anchorX: 9, anchorY: 23 },
  ghost: { palette: GHOST_PAL, frames: [GHOST_A, GHOST_B], anchorX: 9, anchorY: 19 },
  chest: { palette: CHEST_PAL, frames: [CHEST_A], anchorX: 6, anchorY: 9 },
};

function rasterise(grid, palette) {
  const h = grid.length;
  const w = grid[0].length;
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d');
  for (let y = 0; y < h; y++) {
    const row = grid[y];
    for (let x = 0; x < w; x++) {
      const c = row[x];
      if (c === '.') continue;
      ctx.fillStyle = palette[c];
      ctx.fillRect(x, y, 1, 1);
    }
  }
  return canvas;
}

function build(def) {
  const frames = def.frames.map((grid) => ({
    canvas: rasterise(grid, def.palette),
    w: grid[0].length,
    h: grid.length,
    anchorX: def.anchorX,
    anchorY: def.anchorY,
  }));
  const main = { ...frames[0] };
  if (frames.length > 1) main.frames = frames;
  return main;
}

export function buildSprites() {
  return {
    knight: build(ART.knight),
    ghost: build(ART.ghost),
    chest: build(ART.chest),
  };
}
