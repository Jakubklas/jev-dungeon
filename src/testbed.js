// Testbed: a small, hand-configured arena for watching how the explorer reacts (to adversaries,
// cover, open space, corridors) without a whole procedurally generated dungeon around it.
// Builds the same dungeon shape generateDungeon returns, plus the adversary list; turn.js
// `newTestGame(config)` turns it into a game. No Jev calls here. See AGENTS.md "Testbed".
import { DIRS, hasLineOfSight, rng, startSight } from './dungeon.js';
import { SOLID_KINDS, SMALL_KINDS, KINDS, FOOTPRINT_STANDIN, FORGE_SHAPES } from './props/catalog.js';
import { Adversary } from './characters/adversary/adversary.js';
import { PRESET_IDS, charactersFor } from './characters/adversary/character.js';
import { KIND_IDS, kindsFor, levelsFor } from './characters/adversary/kinds.js';
import { LOADOUTS } from './skills/loadouts.js';
import { MAX_SKILLS } from './skills/skill-set.js';
import { spawnCoins } from './coins.js';

export const TESTBED_MIN = 3; // interior floor cells per side
export const TESTBED_MAX = 60;
export const TESTBED_MAX_ADVERSARIES = 8;
export const DEFAULTS = {
  seed: 1,
  size: [11, 11],
  start: 'center',
  treasure: null,
  numAdversaries: 1,
  adversaries: null,
  minAdversaryGap: 4,
  adversariesInSight: null,
  levels: 2, // the monsters' level: 'random' (seeded draw, ghost 1-2, troll 2-3) | 1..4 | a list cycled per monster (kinds.js); 2 = today's stats
  kinds: 'ghost', // the monsters' kind: 'ghost' | 'troll' | 'tree_giant' | 'wolf' | 'mixed' | a list cycled per monster (kinds.js)
  characters: 'standard',
  props: 'none',
  map: null,
  explorerSkills: 'default', // 'default' | 'none' | a list of loadout ids (<= 4)
  ghostSkills: 'default', // 'default' (claw) | 'none' (harmless ghosts)
  ghostHp: null, // 1..5; null = the Skills setting
  morale: null, // 0..100 starting morale for every monster (monster morale, morale.js); null = its character's
  hearts: null, // [x, y] cells of floating hearts: display only, no gameplay yet (null = none)
  explorers: null, // start cells [[x, y], ...] of extra explorers (teammates: ids explorer2, explorer3, ...); null = the one explorer
  coins: 0, // coins lying around: a count (spread like a dungeon's, src/coins.js) or a list of [x, y] cells
};
// Settings hook (src/config/runtime.js): the central config's testbed.* values replace the built-in defaults above.
export function configureTestbed(o) {
  if (o.testbedSizeW !== undefined || o.testbedSizeH !== undefined) DEFAULTS.size = [o.testbedSizeW ?? DEFAULTS.size[0], o.testbedSizeH ?? DEFAULTS.size[1]];
  if (o.testbedSeed !== undefined) DEFAULTS.seed = o.testbedSeed;
  if (o.testbedNumAdversaries !== undefined) DEFAULTS.numAdversaries = o.testbedNumAdversaries;
  if (o.testbedMinGap !== undefined) DEFAULTS.minAdversaryGap = o.testbedMinGap;
  if (o.testbedProps !== undefined) DEFAULTS.props = o.testbedProps;
}
export const TESTBED_MAX_COINS = 60;
export const TESTBED_MAX_EXPLORERS = 4; // extra explorers beside the first
export const TESTBED_MAX_GHOST_HP = 5;
// Solid / small props per interior floor cell for the random prop presets.
const PROP_DENSITY = { few: { solid: 1 / 30, small: 1 / 40 }, many: { solid: 1 / 12, small: 1 / 20 } };
const MAP_CHARS = '#.@TApsc';

const key = ([x, y]) => `${x},${y}`;
const same = (a, b) => a[0] === b[0] && a[1] === b[1];

export class TestbedError extends Error {}
const bad = (msg) => { throw new TestbedError(msg); };

// --- config ------------------------------------------------------------------------------------

const toInt = (v, name) => {
  const n = typeof v === 'string' && v.trim() !== '' ? Number(v) : v;
  if (!Number.isInteger(n)) bad(`${name} must be an integer, got ${JSON.stringify(v)}`);
  return n;
};
// [x, y], "x,y" or "x y".
const toCell = (v, name) => {
  const c = typeof v === 'string' ? v.split(/[ ,]+/).map(Number) : v;
  if (!Array.isArray(c) || c.length !== 2 || !c.every(Number.isInteger)) bad(`${name} must be [x, y], got ${JSON.stringify(v)}`);
  return c;
};
const toBool = (v, name) => {
  if (v === true || v === 'true' || v === '1' || v === '') return true;
  if (v === false || v === 'false' || v === '0') return false;
  return bad(`${name} must be true or false, got ${JSON.stringify(v)}`);
};

// Accepts JSON values or the raw strings of a URL query (?testbed&size=9x9&numAdversaries=2),
// fills defaults and validates. Throws TestbedError with a readable message.
export function normalizeConfig(raw = {}) {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) bad('testbed config must be an object');
  const known = new Set([...Object.keys(DEFAULTS), 'testbed']);
  const unknown = Object.keys(raw).filter((k) => !known.has(k));
  if (unknown.length) bad(`unknown testbed option(s): ${unknown.join(', ')} (known: ${Object.keys(DEFAULTS).join(', ')})`);
  const given = (k) => raw[k] !== undefined && raw[k] !== null && raw[k] !== '';
  const cfg = { ...DEFAULTS };

  if (given('seed')) cfg.seed = toInt(raw.seed, 'seed') >>> 0;
  if (given('size')) {
    const s = typeof raw.size === 'string' ? raw.size.split(/[x, ]+/i).map(Number)
      : typeof raw.size === 'number' ? [raw.size, raw.size] : raw.size;
    if (!Array.isArray(s) || s.length !== 2 || !s.every(Number.isInteger)) bad(`size must be [w, h], "WxH" or one number, got ${JSON.stringify(raw.size)}`);
    if (s.some((n) => n < TESTBED_MIN || n > TESTBED_MAX)) bad(`size sides must be ${TESTBED_MIN}..${TESTBED_MAX}, got ${s.join('x')}`);
    cfg.size = s;
  }
  if (given('start')) cfg.start = raw.start === 'center' || raw.start === 'centre' ? 'center' : toCell(raw.start, 'start');
  if (given('treasure')) {
    cfg.treasure = raw.treasure === 'none' || raw.treasure === false ? null
      : raw.treasure === 'far' ? 'far' : toCell(raw.treasure, 'treasure');
  }
  if (given('numAdversaries')) {
    cfg.numAdversaries = toInt(raw.numAdversaries, 'numAdversaries');
    if (cfg.numAdversaries < 0 || cfg.numAdversaries > TESTBED_MAX_ADVERSARIES) bad(`numAdversaries must be 0..${TESTBED_MAX_ADVERSARIES}`);
  }
  if (given('adversaries')) {
    let list = raw.adversaries;
    if (typeof list === 'string') list = list.split(/[;|]/).filter(Boolean);
    if (!Array.isArray(list)) bad('adversaries must be a list of [x, y] cells (or "x,y;x,y" in a URL)');
    if (list.length > TESTBED_MAX_ADVERSARIES) bad(`at most ${TESTBED_MAX_ADVERSARIES} adversaries`);
    cfg.adversaries = list.map((c, i) => toCell(c, `adversaries[${i}]`));
  }
  if (given('minAdversaryGap')) {
    cfg.minAdversaryGap = toInt(raw.minAdversaryGap, 'minAdversaryGap');
    if (cfg.minAdversaryGap < 1) bad('minAdversaryGap must be at least 1');
  }
  if (given('adversariesInSight')) cfg.adversariesInSight = toBool(raw.adversariesInSight, 'adversariesInSight');
  if (given('kinds')) {
    let k = raw.kinds;
    if (typeof k === 'string' && /[;|,\s]/.test(k.trim())) k = k.trim().split(/[;|,\s]+/).filter(Boolean);
    const ok = (id) => typeof id === 'string' && KIND_IDS.includes(id);
    if (Array.isArray(k)) {
      if (!k.length) bad('kinds list must not be empty');
      k.forEach((id) => { if (!ok(id)) bad(`kinds entry ${JSON.stringify(id)} is not one of ${KIND_IDS.join(', ')}`); });
    } else if (k !== 'mixed' && !ok(k)) bad(`kinds must be 'mixed', one of ${KIND_IDS.join(', ')} or a list, got ${JSON.stringify(k)}`);
    cfg.kinds = k;
  }
  if (given('levels')) {
    let l = raw.levels;
    if (typeof l === 'string' && /[;|,\s]/.test(l.trim())) l = l.trim().split(/[;|,\s]+/).filter(Boolean);
    const num = (x) => (typeof x === 'string' && /^\d+$/.test(x.trim()) ? Number(x) : x);
    const ok = (x) => Number.isInteger(x) && x >= 1 && x <= 4;
    if (Array.isArray(l)) {
      if (!l.length) bad('levels list must not be empty');
      l = l.map(num);
      l.forEach((x) => { if (!ok(x)) bad(`levels entry ${JSON.stringify(x)} is not 1, 2, 3 or 4`); });
    } else if (l !== 'random') {
      l = num(l);
      if (!ok(l)) bad(`levels must be 'random', 1, 2, 3, 4 or a list, got ${JSON.stringify(raw.levels)}`);
    }
    cfg.levels = l;
  }
  if (given('characters')) {
    // 'standard', 'mixed', one preset id, or a list (URL: "ambusher;timid") applied per ghost in id order, cycled.
    let c = raw.characters;
    if (typeof c === 'string' && /[;|,]/.test(c)) c = c.split(/[;|,]/).filter(Boolean);
    const ok = (id) => id === 'mixed' || PRESET_IDS.includes(id);
    if (Array.isArray(c)) {
      if (!c.length) bad('characters list must not be empty');
      c.forEach((id) => { if (!ok(id) || id === 'mixed') bad(`characters entry ${JSON.stringify(id)} is not one of ${PRESET_IDS.join(', ')}`); });
    } else if (typeof c !== 'string' || !ok(c)) bad(`characters must be 'standard', 'mixed', one of ${PRESET_IDS.join(', ')} or a list, got ${JSON.stringify(c)}`);
    cfg.characters = c;
  }
  if (given('props')) {
    if (Array.isArray(raw.props)) {
      cfg.props = raw.props.map((p, i) => {
        if (!p || typeof p !== 'object') bad(`props[${i}] must be { kind, x, y }`);
        if (![...SOLID_KINDS, ...SMALL_KINDS].includes(p.kind)) bad(`props[${i}].kind must be one of ${[...SOLID_KINDS, ...SMALL_KINDS].join(', ')}`);
        const out = { kind: p.kind, x: toInt(p.x, `props[${i}].x`), y: toInt(p.y, `props[${i}].y`), flip: !!p.flip };
        if (KINDS[p.kind].footprint) { // forge: x, y = its top-left cell (min x, min y), w by h cells (default 2 by 2)
          out.w = p.w === undefined ? 2 : toInt(p.w, `props[${i}].w`);
          out.h = p.h === undefined ? 2 : toInt(p.h, `props[${i}].h`);
          if (!FORGE_SHAPES.some(([w, h]) => w === out.w && h === out.h)) bad(`props[${i}] ${p.kind} w x h must be one of ${FORGE_SHAPES.map(([w, h]) => `${w}x${h}`).join(', ')}, got ${out.w}x${out.h}`);
        }
        return out;
      });
    } else if (['none', 'few', 'many'].includes(raw.props)) cfg.props = raw.props;
    else bad(`props must be 'none', 'few', 'many' or a list of { kind, x, y }, got ${JSON.stringify(raw.props)}`);
  }
  if (given('map')) {
    const rows = typeof raw.map === 'string' ? raw.map.split(/\r?\n|\//).map((r) => r.trim()).filter(Boolean) : raw.map;
    if (!Array.isArray(rows) || !rows.length || !rows.every((r) => typeof r === 'string')) bad('map must be a list of row strings (or one string, rows split by newlines or "/")');
    cfg.map = rows;
  }
  if (given('explorerSkills')) {
    let l = raw.explorerSkills;
    if (typeof l === 'string' && /[;|,\s]/.test(l.trim())) l = l.trim().split(/[;|,\s]+/).filter(Boolean);
    if (l === 'default' || l === 'none') cfg.explorerSkills = l;
    else {
      const ids = typeof l === 'string' ? [l] : l;
      if (!Array.isArray(ids) || ids.some((id) => typeof id !== 'string')) bad(`explorerSkills must be 'default', 'none' or a list of loadout ids, got ${JSON.stringify(raw.explorerSkills)}`);
      if (ids.length > MAX_SKILLS) bad(`explorerSkills holds at most ${MAX_SKILLS} skills`);
      for (const id of ids) if (!Object.hasOwn(LOADOUTS, id)) bad(`explorerSkills entry ${JSON.stringify(id)} is not one of ${Object.keys(LOADOUTS).join(', ')}`);
      if (new Set(ids).size !== ids.length) bad('explorerSkills has a duplicate loadout id');
      cfg.explorerSkills = ids.length ? ids : 'none';
    }
  }
  if (given('ghostSkills')) {
    if (raw.ghostSkills !== 'default' && raw.ghostSkills !== 'none') bad(`ghostSkills must be 'default' or 'none', got ${JSON.stringify(raw.ghostSkills)}`);
    cfg.ghostSkills = raw.ghostSkills;
  }
  if (given('coins')) {
    let c = raw.coins;
    if (typeof c === 'string' && /[;|]|,/.test(c)) c = c.split(/[;|]/).filter(Boolean);
    if (Array.isArray(c)) {
      if (c.length > TESTBED_MAX_COINS) bad(`at most ${TESTBED_MAX_COINS} coins`);
      cfg.coins = c.map((cell, i) => toCell(cell, `coins[${i}]`));
    } else {
      cfg.coins = toInt(c, 'coins');
      if (cfg.coins < 0 || cfg.coins > TESTBED_MAX_COINS) bad(`coins must be 0..${TESTBED_MAX_COINS} or a list of cells`);
    }
  }
  if (given('hearts')) {
    let h = raw.hearts;
    if (typeof h === 'string') h = h.split(/[;|]/).filter(Boolean);
    if (h !== null) {
      if (!Array.isArray(h)) bad('hearts must be a list of cells');
      if (h.length > TESTBED_MAX_COINS) bad(`at most ${TESTBED_MAX_COINS} hearts`);
      cfg.hearts = h.map((cell, i) => toCell(cell, `hearts[${i}]`));
    }
  }
  if (given('explorers')) {
    let list = raw.explorers;
    if (typeof list === 'string') list = list.split(/[;|]/).filter(Boolean);
    if (!Array.isArray(list)) bad('explorers must be a list of [x, y] start cells (or "x,y;x,y" in a URL)');
    if (list.length > TESTBED_MAX_EXPLORERS) bad(`at most ${TESTBED_MAX_EXPLORERS} extra explorers`);
    cfg.explorers = list.length ? list.map((c, i) => toCell(c, `explorers[${i}]`)) : null;
  }
  if (given('ghostHp')) {
    cfg.ghostHp = toInt(raw.ghostHp, 'ghostHp');
    if (cfg.ghostHp < 1 || cfg.ghostHp > TESTBED_MAX_GHOST_HP) bad(`ghostHp must be 1..${TESTBED_MAX_GHOST_HP}`);
  }
  if (given('morale')) {
    cfg.morale = toInt(raw.morale, 'morale');
    if (cfg.morale < 0 || cfg.morale > 100) bad('morale must be 0..100');
  }
  return cfg;
}

// What to hand buildSkillSet / ExplorerBrain({ skills }) for a normalized config: 'explorer', 'none' or a list.
export const explorerSkillSetOf = (cfg) => (cfg.explorerSkills === 'default' ? 'explorer' : cfg.explorerSkills);
// Start cells of every explorer of an arena: the first (id 'explorer') at the dungeon start, extras explorer2.. (config.explorers).
export const explorerStartsOf = (dungeon, cfg) => [{ id: 'explorer', start: dungeon.start }, ...(cfg.explorers ?? []).map((c, i) => ({ id: `explorer${i + 2}`, start: c }))];
// The same for ghosts: 'ghost' or 'none'.
export const ghostSkillSetOf = (cfg) => (cfg.ghostSkills === 'none' ? 'none' : 'ghost');

// --- arena -------------------------------------------------------------------------------------

// BFS over floor from `from`: Map key -> steps.
function distances(width, height, tiles, from) {
  const dist = new Map([[key(from), 0]]);
  const queue = [from];
  for (let i = 0; i < queue.length; i++) {
    const [x, y] = queue[i];
    for (const [dx, dy] of Object.values(DIRS)) {
      const n = [x + dx, y + dy];
      if (n[0] < 0 || n[1] < 0 || n[0] >= width || n[1] >= height || tiles[n[1]][n[0]] !== '.' || dist.has(key(n))) continue;
      dist.set(key(n), dist.get(key([x, y])) + 1);
      queue.push(n);
    }
  }
  return dist;
}

function shuffle(rand, items) {
  for (let i = items.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [items[i], items[j]] = [items[j], items[i]];
  }
  return items;
}

// Parses an ASCII map: '#' wall, '.' floor, '@' start, 'T' chest, 'A' adversary,
// 'p' solid prop (random solid kind), 's' small prop (random small kind), 'c' coin. The border must be wall.
function parseMap(rows) {
  const width = rows[0].length;
  const height = rows.length;
  if (rows.some((r) => r.length !== width)) bad('map rows must all be the same length');
  if (width < TESTBED_MIN + 2 || height < TESTBED_MIN + 2 || width > TESTBED_MAX + 2 || height > TESTBED_MAX + 2) {
    bad(`map must be ${TESTBED_MIN + 2}..${TESTBED_MAX + 2} cells per side, wall ring included`);
  }
  const out = { width, height, grid: [], start: null, treasure: null, adversaries: [], solid: [], small: [], coins: [] };
  for (let y = 0; y < height; y++) {
    const row = [];
    for (let x = 0; x < width; x++) {
      const c = rows[y][x];
      if (!MAP_CHARS.includes(c)) bad(`map has an unknown character ${JSON.stringify(c)} at ${x},${y} (legend: ${MAP_CHARS})`);
      const border = x === 0 || y === 0 || x === width - 1 || y === height - 1;
      if (border && c !== '#') bad(`map border must be wall ('#'), found ${JSON.stringify(c)} at ${x},${y}`);
      if (c === '@') { if (out.start) bad('map has more than one @'); out.start = [x, y]; }
      if (c === 'T') { if (out.treasure) bad('map has more than one T'); out.treasure = [x, y]; }
      if (c === 'A') out.adversaries.push([x, y]);
      if (c === 'p') out.solid.push([x, y]);
      if (c === 's') out.small.push([x, y]);
      if (c === 'c') out.coins.push([x, y]);
      row.push(c === '#' || c === 'p' ? '#' : '.');
    }
    out.grid.push(row);
  }
  if (!out.start) bad('map needs a start cell (@)');
  if (out.adversaries.length > TESTBED_MAX_ADVERSARIES) bad(`map has more than ${TESTBED_MAX_ADVERSARIES} adversaries`);
  return out;
}

// A footprint kind (forge) can't stand on one random cell: the pick stays (same rng draws), a crate stands in.
const standIn = (kind) => (KINDS[kind].footprint ? FOOTPRINT_STANDIN : kind);

// Random solid clusters (1-3 cells) and small props for the 'few' / 'many' presets. Solid cells keep
// the start's 3x3, the chest's 3x3 and adversary cells clear, and never cut any floor off.
function randomProps(rand, grid, width, height, start, keepClear, density) {
  const floorCells = [];
  for (let y = 1; y < height - 1; y++) for (let x = 1; x < width - 1; x++) if (grid[y][x] === '.') floorCells.push([x, y]);
  const near = (c) => [start, ...keepClear].some((k) => k && Math.abs(c[0] - k[0]) <= 1 && Math.abs(c[1] - k[1]) <= 1);
  const solidTarget = Math.round(floorCells.length * density.solid);
  const solid = [];
  const blocked = new Set(); // cells within one of a placed cluster (one free cell between clusters)
  const floorCount = () => grid.flat().filter((c) => c === '.').length;
  for (const seedCell of shuffle(rand, floorCells.slice())) {
    if (solid.length >= solidTarget) break;
    if (near(seedCell) || blocked.has(key(seedCell)) || grid[seedCell[1]][seedCell[0]] !== '.') continue;
    const size = 1 + Math.floor(rand() * 3);
    const cells = [seedCell];
    for (let k = 1; k < size; k++) {
      const [dx, dy] = rand() < 0.5 ? [1, 0] : [0, 1];
      const n = [cells.at(-1)[0] + dx, cells.at(-1)[1] + dy];
      if (n[0] >= width - 1 || n[1] >= height - 1 || grid[n[1]][n[0]] !== '.' || near(n) || blocked.has(key(n))) break;
      cells.push(n);
    }
    const before = floorCount();
    for (const [x, y] of cells) grid[y][x] = '#';
    if (distances(width, height, grid.map((r) => r.join('')), start).size !== before - cells.length) {
      for (const [x, y] of cells) grid[y][x] = '.';
      continue;
    }
    const flip = rand() < 0.5;
    for (const c of cells) {
      solid.push({ kind: standIn(SOLID_KINDS[Math.floor(rand() * SOLID_KINDS.length)]), x: c[0], y: c[1], flip });
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) blocked.add(key([c[0] + dx, c[1] + dy]));
    }
  }
  const smallTarget = Math.round(floorCells.length * density.small);
  const small = shuffle(rand, floorCells.filter((c) => grid[c[1]][c[0]] === '.' && !near(c)))
    .slice(0, smallTarget)
    .map(([x, y]) => ({ kind: SMALL_KINDS[Math.floor(rand() * SMALL_KINDS.length)], x, y, flip: rand() < 0.5 }));
  return [...solid.map((p) => ({ ...p, solid: true })), ...small.map((p) => ({ ...p, solid: false }))];
}

// config (raw or normalized) -> { dungeon, adversaries, config }. Coordinates include the wall
// ring: a size [w, h] arena is (w+2) x (h+2) cells with floor at x 1..w, y 1..h.
export function buildArena(rawConfig = {}) {
  const cfg = normalizeConfig(rawConfig);
  const rand = rng(cfg.seed ^ 0x51ed27a3);
  let width, height, grid, start, treasure, fixedAdversaries = cfg.adversaries, props = [], fixedCoins = Array.isArray(cfg.coins) ? cfg.coins : null;

  if (cfg.map) {
    const m = parseMap(cfg.map);
    ({ width, height, grid, start } = m);
    treasure = m.treasure ?? (cfg.treasure === 'far' || Array.isArray(cfg.treasure) ? cfg.treasure : null);
    if (m.adversaries.length) fixedAdversaries = m.adversaries;
    if (m.coins.length) fixedCoins = m.coins;
    const pick = (kinds) => kinds[Math.floor(rand() * kinds.length)];
    props = [
      ...m.solid.map(([x, y]) => ({ kind: standIn(pick(SOLID_KINDS)), x, y, solid: true, flip: rand() < 0.5 })),
      ...m.small.map(([x, y]) => ({ kind: pick(SMALL_KINDS), x, y, solid: false, flip: rand() < 0.5 })),
    ];
  } else {
    const [w, h] = cfg.size;
    width = w + 2;
    height = h + 2;
    grid = Array.from({ length: height }, (_, y) => Array.from({ length: width }, (_, x) =>
      (x === 0 || y === 0 || x === width - 1 || y === height - 1 ? '#' : '.')));
    start = cfg.start === 'center' ? [1 + Math.floor((w - 1) / 2), 1 + Math.floor((h - 1) / 2)] : cfg.start;
    treasure = cfg.treasure;
  }

  const inside = ([x, y]) => x > 0 && y > 0 && x < width - 1 && y < height - 1;
  const floorAt = ([x, y]) => inside([x, y]) && grid[y][x] === '.';
  if (!floorAt(start)) bad(`start ${start} is not an inside floor cell (floor is x 1..${width - 2}, y 1..${height - 2})`);

  // Explicit props (config list) become part of the grid before anything is checked against it.
  if (Array.isArray(cfg.props)) {
    for (const p of cfg.props) {
      if (!floorAt([p.x, p.y])) bad(`prop ${p.kind} at ${p.x},${p.y} is not on an inside floor cell`);
      if (same([p.x, p.y], start)) bad(`prop ${p.kind} sits on the start`);
      const solid = SOLID_KINDS.includes(p.kind);
      if (p.w) { // footprint kind: one entry per cell, the anchor (top-left) carries w and h
        for (let dy = 0; dy < p.h; dy++) {
          for (let dx = 0; dx < p.w; dx++) {
            if (!floorAt([p.x + dx, p.y + dy])) bad(`prop ${p.kind} ${p.w}x${p.h} at ${p.x},${p.y}: cell ${p.x + dx},${p.y + dy} is not an inside floor cell`);
            if (same([p.x + dx, p.y + dy], start)) bad(`prop ${p.kind} at ${p.x},${p.y} covers the start`);
            props.push({ kind: p.kind, x: p.x + dx, y: p.y + dy, solid: true, flip: p.flip, ...(dx || dy ? { part: true } : { w: p.w, h: p.h }) });
            grid[p.y + dy][p.x + dx] = '#';
          }
        }
        continue;
      }
      props.push({ kind: p.kind, x: p.x, y: p.y, solid, flip: p.flip });
      if (solid) grid[p.y][p.x] = '#';
    }
  }

  // The chest: 'far' = a farthest floor cell from the start (tie-break y, x).
  if (treasure === 'far') {
    const dist = distances(width, height, grid.map((r) => r.join('')), start);
    let best = null;
    for (const [k, d] of dist) {
      const c = k.split(',').map(Number);
      if (!best || d > best.d || (d === best.d && (c[1] < best.c[1] || (c[1] === best.c[1] && c[0] < best.c[0])))) best = { c, d };
    }
    treasure = best && best.d > 0 ? best.c : null;
  }
  if (treasure) {
    if (!floorAt(treasure)) bad(`treasure ${treasure} is not an inside floor cell`);
    if (same(treasure, start)) bad('treasure and start are the same cell');
  }

  if (!cfg.map && (cfg.props === 'few' || cfg.props === 'many')) {
    props = randomProps(rand, grid, width, height, start, [treasure, ...(fixedAdversaries ?? [])], PROP_DENSITY[cfg.props]);
  }
  const tiles = grid.map((r) => r.join(''));
  const dist = distances(width, height, tiles, start);
  if (treasure && !dist.has(key(treasure))) bad(`treasure ${treasure} is not reachable from the start`);
  const smallAt = new Set(props.filter((p) => !p.solid).map((p) => key([p.x, p.y])));
  props = props.filter((p) => p.solid || !(treasure && same([p.x, p.y], treasure)));
  props.sort((a, b) => a.y - b.y || a.x - b.x);

  // Adversaries: explicit cells, or random reachable floor at least minAdversaryGap steps away.
  let positions;
  if (fixedAdversaries) {
    positions = fixedAdversaries.map((c) => {
      if (!floorAt(c)) bad(`adversary at ${c} is not an inside floor cell`);
      if (same(c, start)) bad(`adversary at ${c} sits on the start`);
      return [...c];
    });
  } else {
    const sees = (c) => Math.hypot(c[0] - start[0], c[1] - start[1]) <= startSight() &&
      hasLineOfSight({ width, height, tiles }, start, c);
    const pool = [...dist].filter(([k, d]) => d >= cfg.minAdversaryGap)
      .map(([k]) => k.split(',').map(Number))
      .filter((c) => !(treasure && same(c, treasure)) && !smallAt.has(key(c)))
      .filter((c) => cfg.adversariesInSight === null || sees(c) === cfg.adversariesInSight)
      .sort((a, b) => a[1] - b[1] || a[0] - b[0]);
    if (pool.length < cfg.numAdversaries) {
      bad(`only ${pool.length} cell(s) fit ${cfg.numAdversaries} adversaries (minAdversaryGap ${cfg.minAdversaryGap}` +
        `${cfg.adversariesInSight === null ? '' : `, in sight ${cfg.adversariesInSight}`}); use a bigger size or a smaller gap`);
    }
    positions = shuffle(rand, pool).slice(0, cfg.numAdversaries);
  }
  // Adversary instances keep exactly the contracted public shape (AGENTS.md: don't add fields).
  const characters = charactersFor(cfg.characters, cfg.seed, positions.length);
  const kinds = kindsFor(cfg.kinds, cfg.seed, positions.length);
  const levels = levelsFor(cfg.levels, cfg.seed, kinds);
  const adversaries = positions.map((pos, i) => new Adversary({
    id: `a${i + 1}`, pos, character: rawConfig.characters === undefined ? undefined : characters[i], kind: kinds[i], level: levels[i], ...(cfg.ghostSkills === 'none' ? { skills: 'none' } : {}), ...(cfg.ghostHp != null ? { hp: cfg.ghostHp } : {}),
  }));
  // A starting morale for the arena (monster morale): the score and the baseline it returns to. It only shows
  // with the monsterMorale toggle on; with it off the state is there and nothing reads it.
  if (cfg.morale !== null) for (const a of adversaries) a.hunt.morale = { ...a.hunt.morale, value: cfg.morale, baseline: cfg.morale };

  const dungeon = {
    seed: cfg.seed,
    width, height, tiles, start: [...start], treasure: treasure ? [...treasure] : null,
    // One room over the whole inside, so patrol goals (roomCells) cover every floor cell.
    rooms: [{ x: 1, y: 1, w: width - 2, h: height - 2 }],
    props,
    decor: [],
    testbed: true,
  };
  // Coins: explicit cells, or a count spread by src/coins.js on its own stream (the arena never changes).
  if (fixedCoins) {
    dungeon.coins = fixedCoins.map((c) => {
      if (!floorAt(c)) bad(`coin at ${c} is not an inside floor cell`);
      if (same(c, start)) bad(`coin at ${c} sits on the start`);
      return [...c];
    });
  } else {
    dungeon.coins = spawnCoins(dungeon, { count: cfg.coins });
  }
  dungeon.hearts = (cfg.hearts ?? []).map((c) => {
    if (!floorAt(c)) bad(`heart at ${c} is not an inside floor cell`);
    return [...c];
  });
  if (cfg.explorers) {
    cfg.explorers.forEach((c, i) => {
      if (!floorAt(c)) bad(`explorers[${i}] ${c} is not an inside floor cell`);
      if (same(c, start) || cfg.explorers.some((o, j) => j < i && same(o, c))) bad(`explorers[${i}] ${c} shares a start cell`);
    });
    if (positions.some((p) => cfg.explorers.some((c) => same(c, p)))) bad('an extra explorer starts on an adversary');
  }
  return { dungeon, adversaries, config: cfg };
}
