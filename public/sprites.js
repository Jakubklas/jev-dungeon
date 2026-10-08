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
  o: '#11170b', // outline (olive-tinted dark)
  m: '#1c2913', // moss deep
  d: '#2e4220', // moss
  v: '#4a6a2c', // moss tuft light
  s: '#3f4422', // skin shade (olive)
  g: '#5a6330', // skin
  l: '#7b8443', // skin light
  h: '#a3a85d', // skin highlight
  e: '#ffc633', // glowing slit eyes (coin gold)
  k: '#13131f', // mouth, skull sockets (bone ramp socket)
  b: '#e3daa7', // fangs, tusks, claws, skulls (bone ramp)
  B: '#b6a96e', // bone shade
  x: '#2d1608', // belt and loincloth (wood ramp)
  w: '#603312',
  W: '#93531f',
  c: '#c4782e',
  n: '#3f5b6f', // ring buckle (steel ramp)
  M: '#6f8fa5',
  L: '#abbfce',
  q: '#edf3f7',
};

// ---------------------------------------------------------------- troll 40x48 (two blocks tall: twice the knight)
// A hunched brute lit from the upper left. Value hierarchy: a dark moss mane (crest over the crown, drape over the
// far shoulder) behind a lighter olive face and chest, split from the legs by the dark belt. A V-shaped body with
// clear gaps between the arms and the flanks; a small forward head with a pointed ear, gold slit eyes and a fanged
// mouth; pecs and abs drawn with shade tones, not outlines. Story details: the steel ring buckle, two bone skulls on
// the belt, rag strips on the loincloth, bone claws on fists and toes. The far arm and leg sit one tone darker.
// TROLL_B settles everything above row 21 (a plain chest row under the pecs) by one row (breathing).
const TROLL_A = [
  '........................................',
  '...........o..o..o..o...o...............',
  '........o.odoodoodoodo.ovo.o............',
  '.......odoododddddddovooooodo.o.........',
  '........o.vddvvddvvoovvvvvvddodo........',
  '.........vvdddddddovvvvvvvvddddo........',
  '.....o..oddddddododdddddddddddddo.......',
  '....odoommmmvmohomoddddddddddddo........',
  '.....o.vmmmvmmohhoooddhhhhhhhhgo........',
  '......vvmmmmmmdolllogossssosssoso.......',
  '...o...ommmmmmmmossgogkeeggkeegso.......',
  '..odooooovmmmmmmdoogggssglgssggso.......',
  '..ommvmmvmmmmmmmmmmogoglhsgggggso.......',
  '..omvmmmmmmmmmmmmmmookkkkkkkkkkoo.......',
  '..ommmmmmmmmdmmmmmogobkbkkbkkbkooooo....',
  '.ommmmmmmmmmmmmoooobokbkkbkbkkbdddolo...',
  '.ommmmvmmmdmmmmolloggokkkkkkkkdvsvddoo..',
  '.ommmvmmmmmmmmmolllogggggggggsgsohhlgso.',
  '.ommmmmmmvmmmmohhhhlooossssssooohhhlgso.',
  '.omvmmmmvmmmmohhhlllshhoooooolllllllgso.',
  '..omvmmmmmmmolllllllslllllllolllllllgso.',
  '..oommmdmmmollllllllslllllllolllllllgso.',
  '..oommmommmollllllllsllllllllollhlgggo..',
  '..ogomosomossssssssssssssssgggolhlgggo..',
  '..oggossdossggggllgsgllgggggggollggggo..',
  '...ogsssdossggggggggggggggggggollggggo..',
  '...ogsssdossggggssgsgssgggggggsosssssso.',
  '...ogsssdossggggllgsgllgggggsssolgggsso.',
  '...ogsssdoosggggggggggggggggsssolggggso.',
  '...ogsssdoosggggssgsgssgggggsssolggggso.',
  '...ooooodooooooooooooooooooooooolooooso.',
  '...oggsso.oWobbboWWoLqLMMoobbbooolllgo..',
  '..ogggsssoowbkbkbwwoLnknMobkbkbollslsgo.',
  '.osssssssdoxobBboxxoMMnnnoobBboollllggso',
  '.osssssssdooooboooooooooooooboogggggggso',
  '.osssssssdooggoWWxWwcwxwwxxxosogggggggso',
  '..osssssso.oggoWWxWwcwxwwxxxosoosssssso.',
  '...bobdoob.oggoWWxWwcwxwwxxxoso.bsosboob',
  '....oooo...oggoWWxWwcwxwwxxxoso..oooo...',
  '...........oggoWWxWwcwxwwxxxoso.........',
  '...........oggoWooWwowxwooxogso.........',
  '...........oggsossoo.oxolgoggso.........',
  '...........ooooooooo..oooooooooo........',
  '..........oggggsssso..olllllggggo.......',
  '.........ogggggsssssoollllllgggggo......',
  '.........ossssssssssoogggggggggggo......',
  '..........oBdBdBdddo..osbsbsbsbso.......',
  '...........oooooooo....ooooooooo........',
];

const TROLL_B = ['.'.repeat(40), ...TROLL_A.slice(0, 21), ...TROLL_A.slice(22)];

// Walk cycle: the feet are rows 43-47 (left foot cols 9-20, right foot cols 22-32). A step lifts one foot two rows
// and a column forward (it still hangs over the loincloth hem), while the planted foot stays on the ground; the
// passing frames reuse the idle art with the torso a row lower (a stride dips the body). Four frames: lift left,
// pass, lift right, pass.
function liftFoot(base, x0, x1, dx, lowerBody) {
  const g = (lowerBody ? TROLL_B : base).map((r) => r.split(''));
  for (let y = 43; y <= 47; y++) for (let x = x0; x <= x1; x++) g[y][x] = '.';
  for (let y = 43; y <= 47; y++) {
    for (let x = x0; x <= x1; x++) {
      const c = base[y][x];
      if (c !== '.' && x + dx >= 0 && x + dx < 40) g[y - 2][x + dx] = c;
    }
  }
  return g.map((r) => r.join(''));
}
const TROLL_WALK = [
  liftFoot(TROLL_A, 9, 20, 1, true),
  TROLL_A,
  liftFoot(TROLL_A, 22, 32, 1, true),
  TROLL_A,
];

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

// ----------------------------------------------------------------- heart 7x7
// A floating heart pickup: same size, anchor and hover as the coin; the knight's red ramp (STYLE_GUIDELINES).
const HEART_PAL = { o: '#2b0508', R: '#d11920', d: '#750b0f', L: '#ff9a8f' };
const HEART_A = [
  '.oo.oo.',
  'oLRoRRo',
  'oLRRRRo',
  'oRRRRdo',
  '.oRRdo.',
  '..odo..',
  '...o...',
];

// Raw art data (DOM-free) so it can be validated / previewed in node.
export const ART = {
  knight: { palette: KNIGHT_PAL, frames: [KNIGHT_A, KNIGHT_B], anchorX: 9, anchorY: 23 },
  ghost: { palette: GHOST_PAL, frames: [GHOST_A, GHOST_B], anchorX: 9, anchorY: 19 },
  troll: { palette: TROLL_PAL, frames: [TROLL_A, TROLL_B], walk: TROLL_WALK, anchorX: 20, anchorY: 47 },
  chest: { palette: CHEST_PAL, frames: [CHEST_A], anchorX: 6, anchorY: 9 },
  coin: { palette: COIN_PAL, frames: [COIN_A], anchorX: 3, anchorY: 5 },
  heart: { palette: HEART_PAL, frames: [HEART_A], anchorX: 3, anchorY: 5 },
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
  if (def.walk) main.walk = def.walk.map((grid) => ({ ...frames[0], canvas: rasterise(grid, def.palette) }));
  return main;
}

export function buildSprites() {
  return {
    knight: build(ART.knight),
    ghost: build(ART.ghost),
    troll: build(ART.troll),
    chest: build(ART.chest),
    coin: build(ART.coin),
    heart: build(ART.heart),
  };
}
