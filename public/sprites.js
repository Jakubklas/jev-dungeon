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

const TROLL_PAL = {
  o: '#101a0e', // outline (green-tinted dark)
  m: '#172b14', // moss (deep shade)
  d: '#25401f', // skin shade
  g: '#3f6a2b', // skin
  l: '#5f8f3c', // skin light
  h: '#8fb85a', // skin highlight
  e: '#ffc633', // glowing yellow eye (coin gold)
  k: '#13131f', // mouth, pupils
  b: '#e3daa7', // teeth, tusks, claws, belt trinkets (bone ramp)
  B: '#b6a96e', // bone shade
  x: '#2d1608', // belt and loincloth (wood ramp)
  w: '#603312',
  W: '#93531f',
  c: '#c4782e',
  n: '#3f5b6f', // belt buckle (steel ramp)
  M: '#6f8fa5',
  L: '#abbfce',
  q: '#edf3f7',
};

// ---------------------------------------------------------------- troll 40x48 (two blocks tall: twice the knight)
// A hunched brute lit from the upper left: a moss-spiked hump, a fanged jaw with two tusks and glowing eyes, long
// arms ending in clawed fists, a wood belt with a steel buckle and bone trinkets, a ragged loincloth. Far limbs
// and the back sit one tone darker for depth. TROLL_B settles the head and shoulders one row (breathing).
const TROLL_A = [
  '........................................',
  '........................................',
  '............o.........ooooooo...........',
  '.........o..o..o....oohhlgllhoo.........',
  '.........o.omo.o...ohhhglllllggo........',
  '......o.omoomoomo.ohhllllllgggggo.......',
  '......o.omommmomo.ohllgllldglgggo.......',
  '.....omommommommmomolmmmmmmmmmmmmm......',
  '.....omooolllgggoomolllddddddddddo......',
  '....ommmoglgggggollllggggkeeggkeeo......',
  '...o.ollllgdgggollllgggggoooooooooo.....',
  '...oolllggggggmmolgggggoohhhhlllllom....',
  '..omolgggdmmggddogggggdddhllllllgggmo...',
  '..omogggggdggdddolgggohhllllllgooogggo..',
  '...oggggmmgdddddmmgglollBllggoohhloogo..',
  '...oggggdgdddddddoggolllkbBbkbkbkBkbodo.',
  '...oggmmddddmmdoohoggoggkkbkkkkkkbbkgo..',
  '..ogggdddddddoohhhhomoggkkbkbkbkkbkkdo..',
  '...ogdddddddohhhhmllooogBgollllgdggggo..',
  '...ogddmmddohhhhllllllooodollgglggggdo..',
  '...oddddddommhhllldddddddoolggggggggdo..',
  '..odddgddohdhhlllllldggggggogggggdgggo..',
  '..oodddddohlllgllllldggggggolggggggggo..',
  '..ooddddommlllllldddddddgggolggggggggo..',
  '..ogodddodllllllgglgdggggggolggggggggdo.',
  '..ogdoddollllllgggggdggdgggolggggdgggdo.',
  '..olgdooolllhggggdddddddoooogggggggggdo.',
  '..ogddddollhggggggggdgoohhlolggggggmggo.',
  '.oggdmddoooooooooooodoooooooogggggggggo.',
  '.ogddddoWmWcWwwwWwnnnnnwwWwxolggglggggo.',
  '.ogddoddoWWWWBBwwwnqLMnxbbwxolggooooogo.',
  '.ooooloooWWcWBwcwwnMLMnwkbkcocoohhhllooo',
  '.olllggggoWWWwBwwwnMMnnwbwwxoohhhllllggo',
  '.olggggddooWWwWwwwnnnnnwwwwxolhlllllgggo',
  'oggggddddoloooooooooooooooooohllllgggggo',
  'ogggddddogggdocxWWxWWxwwxwwwolllgggggggo',
  'ogddddddogggdoWWWWwwwwwwwwwolllgggglggdo',
  'odddddddogggddoxwWxwwxwwxxxoogggggggdddo',
  'odddddddolggddowwwwwwwwxxxxoogggggdddddo',
  '.oBdddddoggddddxwwxWwxxxxxxooggggddddddo',
  '..ooBdBooggddddowwxxxxxxxxoggogdBdddBoo.',
  '.....o..oggddddowxxoooxxxxoglgoodoBoo...',
  '........ooooooooooo...ooooooooooo.......',
  '........ollgggggddo...oohhllllllo.......',
  '.......oglggddddddo...olllllgggggoo.....',
  '......oggdgddddddddo.ollgggglggddddo....',
  '.......odddddddgddo...oggggggddddoo.....',
  '........BooBooBooo.....oBooBooBoo.......',
];

const TROLL_B = ['.'.repeat(40), ...TROLL_A.slice(0, 20), ...TROLL_A.slice(21)];

// ----------------------------------------------------------------- coin 7x7
const COIN_PAL = { o: '#3a2406', y: '#ffc633', L: '#fff0a8', d: '#c98a14' };
const COIN_A = [
  '..ooo..',
  '.oLyyo.',
  'oLyddyo',
  'oyydyyo',
  'oyddyyo',
  '.oyyyo.',
  '..ooo..',
];

// Raw art data (DOM-free) so it can be validated / previewed in node.
export const ART = {
  knight: { palette: KNIGHT_PAL, frames: [KNIGHT_A, KNIGHT_B], anchorX: 9, anchorY: 23 },
  ghost: { palette: GHOST_PAL, frames: [GHOST_A, GHOST_B], anchorX: 9, anchorY: 19 },
  troll: { palette: TROLL_PAL, frames: [TROLL_A, TROLL_B], anchorX: 20, anchorY: 47 },
  chest: { palette: CHEST_PAL, frames: [CHEST_A], anchorX: 6, anchorY: 9 },
  coin: { palette: COIN_PAL, frames: [COIN_A], anchorX: 3, anchorY: 5 },
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
    troll: build(ART.troll),
    chest: build(ART.chest),
    coin: build(ART.coin),
  };
}
