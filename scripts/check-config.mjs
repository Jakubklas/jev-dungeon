// Central config (src/config/): registry defaults against the old SCHEMA, the YAML template round trip, layering,
// cross-field rules, bad-entry warnings, a broken file, the userSetting flag and the user scope. Free, no Jev, no network.
// Never reads the real central-config.yaml: JEV_CONFIG is set to scratch files before the modules load.
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import YAML from 'yaml';

const dir = mkdtempSync(join(tmpdir(), 'jev-config-'));
process.env.JEV_CONFIG = 'none'; // set before the dynamic imports: configFile() reads it when called
delete process.env.DATA_DIR;
globalThis.fetch = () => { throw new Error('fetch tripwire: config checks must not call Jev'); };

let failed = 0;
const check = (ok, msg) => { if (!ok) { failed++; console.log('FAIL: ' + msg); } };

const R = await import('../src/config/registry.js');
const L = await import('../src/config/load.js');
const S = await import('../src/config/runtime.js');
const C = await import('../src/characters/adversary/character.js');
const D = await import('../src/dungeon.js');
const CAT = await import('../src/props/catalog.js');
const ADV = await import('../src/characters/adversary/adversary.js');
const TB = await import('../src/testbed.js');
const LD = await import('../src/skills/loadouts.js');
const SK = await import('../src/skills/config.js');
const KD = await import('../src/characters/adversary/kinds.js');
const QS = await import('../src/skills/question.js');
const BR = await import('../src/characters/explorer/brain.js');
const PE = await import('../src/characters/explorer/perception.js');
const EN = await import('../src/characters/explorer/encounter.js');
const CF = await import('../src/characters/explorer/confidence.js');
const AB = await import('../src/characters/adversary/brain.js');
const AP = await import('../src/characters/adversary/perception.js');
const AM = await import('../src/characters/adversary/memory.js');
const AV = await import('../src/characters/adversary/adversary-view.js');
const MR = await import('../src/characters/adversary/morale.js');
const EM = await import('../src/characters/explorer/memory.js');
const AT = await import('../src/skills/attack.js');
const { REQUEST_BYTES } = R;
const JV = await import('../src/jev.js');
const TX = await import('../src/config/texts.js');
const TH = await import('../public/thoughts.js');
const appSrc = readFileSync(fileURLToPath(new URL('../public/app.js', import.meta.url)), 'utf8');
// The browser's timing constants, read from app.js itself: the registry default must be the literal the page falls back to.
const UI_CONST = { camMs: 'CAM_MS', logMax: 'LOG_MAX', fadeMs: 'FADE_MS', tweenMs: 'TWEEN_MS', bobMs: 'BOB_MS', animMs: 'ANIM_MS', walkMs: 'WALK_MS', strikeMs: 'STRIKE_MS', slashMs: 'SLASH_MS', fireMs: 'FIRE_MS', fireCallMs: 'FIRE_CALL_MS', revealAlpha: 'REVEAL_ALPHA', bubbleIn: 'BUBBLE_IN', bubbleOut: 'BUBBLE_OUT', blinkMs: 'BLINK_MS', coinGlowMs: 'COIN_GLOW_MS' };
const uiLiteral = (name) => { const m = new RegExp(`\\b${name} = (\\.?[0-9][0-9._]*)`).exec(appSrc); return m ? Number(m[1].replace(/_/g, '')) : undefined; };
const { eq } = L;
const { generateDungeon } = D;

// The 39 knobs as they were in src/settings.js before the registry (key, default, when): frozen on purpose.
const OLD = [
  ['speed', 0.6, 'live'],
  ['chaseRange', 7, 'live'],
  ['sightRange', 7, 'live'],
  ['maxSearchTicks', 18, 'live'],
  ['keepHuntingMin', 0.5, 'live'],
  ['adversaryCharacters', false, 'next'],
  ['limitedMap', false, 'next'],
  ['monsterMorale', false, 'next'],
  ['injectEnabled', true, 'live'],
  ['injectMaxChars', 140, 'live'],
  ['injectSteps', 20, 'live'],
  ['injectCooldownS', 10, 'live'],
  ['graceTicks', 4, 'live'],
  ['packAlert', true, 'live'],
  ['alertSteps', 24, 'live'],
  ['teamSight', true, 'live'],
  ['floorPerAdversary', 150, 'next'],
  ['trollShare', 0.25, 'next'],
  ['maxAdversaries', 12, 'next'],
  ['floorPerCoin', 60, 'next'],
  ['maxCoins', 30, 'next'],
  ['swordDamage', 1, 'next'],
  ['swordCooldown', 1, 'next'],
  ['shieldChance', 0.6, 'next'],
  ['shieldCooldown', 2, 'next'],
  ['clawDamage', 1, 'next'],
  ['clawCooldown', 2, 'next'],
  ['ghostHp', 2, 'next'],
  ['trollHp', 4, 'next'],
  ['trollClawDamage', 2, 'next'],
  ['trollSpeed', 0.65, 'next'],
  ['trollStunTicks', 0, 'next'],
  ['roomsPerHeart', 4, 'next'],
  ['maxHearts', 6, 'next'],
  ['coinDropChance', 0.6, 'next'],
  ['stunTicks', 2, 'next'],
  ['lives', 4, 'next'],
  ['lightRadius', 7, 'next'],
  ['minSize', 25, 'next'],
  ['maxSize', 90, 'next'],
  ['roomArea', 290, 'next']
];

// 1. registry vs the old schema
check(OLD.length === 41, `frozen list has 41 rows, got ${OLD.length}`);
const byKey = new Map(L.SCHEMA.map((s) => [s.key, s]));
for (const [key, def, when] of OLD) {
  const row = byKey.get(key);
  check(row, `registry lacks ${key}`);
  if (row) { check(row.def === def, `${key} default ${row.def} != ${def}`); check(row.when === when, `${key} applies ${row.when} != ${when}`); }
}
check(L.SCHEMA.length === OLD.length, `schema has ${L.SCHEMA.length} rows, old had ${OLD.length}`);
check(new Set(R.KNOBS.map((k) => k.path).filter(Boolean)).size === R.KNOBS.filter((k) => k.path).length, 'paths are unique');
check(new Set(R.KNOBS.map((k) => k.key)).size === R.KNOBS.length, 'keys are unique');
for (const k of R.KNOBS) {
  check(typeof k.doc === 'string' && k.doc.length > 0 && k.doc.length <= 100, `${k.key} has a short doc`);
  if (k.type === 'range') check(k.def >= k.min && k.def <= k.max, `${k.key} default inside its range`);
}

// 1b. P1: each file-only knob's default equals the literal its module holds before any config is applied
const LIT = {
  regenSteps: D.REGEN_STEPS, helpReachSteps: D.HELP_REACH_STEPS, regenAmount: D.REGEN_AMOUNT, heartRespawn: D.HEART_RESPAWN,
  roomMin: D.ROOM_MIN, roomMax: D.ROOM_MAX, minRooms: D.MIN_ROOMS, loopShare: D.LOOP_SHARE, loopMin: D.LOOP_MIN, treasureShare: D.TREASURE_SHARE,
  layout: D.LAYOUT,
  torchMin: CAT.TORCH_MIN, torchMax: CAT.TORCH_MAX, torchGap: CAT.TORCH_GAP, corridorTorchPerRoom: CAT.CORRIDOR_TORCH_PER_ROOM, corridorTorchGap: CAT.CORRIDOR_TORCH_GAP,
  bigMinRun: CAT.BIG_MIN_RUN, bigChance: CAT.BIG_CHANCE, clusterSizeMin: CAT.CLUSTER_SIZE_MIN, clusterSizeMax: CAT.CLUSTER_SIZE_MAX, clusterPerCells: CAT.CLUSTER_PER_CELLS,
  clusterMax: CAT.CLUSTER_MAX, clusterGap: CAT.CLUSTER_GAP, clusterTries: CAT.CLUSTER_TRIES, minExits: CAT.MIN_EXITS,
  forgeRoomChance: CAT.FORGE_ROOM_CHANCE, forgeMinInner: CAT.FORGE_MIN_INNER, forgeMinArea: CAT.FORGE_MIN_AREA,
  smallPerCells: CAT.SMALL_PER_CELLS, smallMax: CAT.SMALL_MAX, corridorSmallPerCells: CAT.CORRIDOR_SMALL_PER_CELLS,
  spawnMinSteps: ADV.MIN_SPAWN_STEPS,
  testbedSizeW: TB.DEFAULTS.size[0], testbedSizeH: TB.DEFAULTS.size[1], testbedSeed: TB.DEFAULTS.seed, testbedNumAdversaries: TB.DEFAULTS.numAdversaries,
  testbedMinGap: TB.DEFAULTS.minAdversaryGap, testbedProps: TB.DEFAULTS.props,
  ...Object.fromEntries(Object.keys(CAT.KINDS).filter((id) => id !== 'torch').map((id) => [`propWeight_${id}`, CAT.KINDS[id].weight])),
  // P2
  explorerSkills: [...LD.DEFAULT_SETS.explorer], ghostSkills: [...LD.DEFAULT_SETS.ghost], trollSkills: [...KD.KINDS.troll.skills],
  fireDamage: LD.LOADOUTS.fire_strike.damage, fireCooldown: LD.LOADOUTS.fire_strike.cooldown, dashCooldown: LD.LOADOUTS.dash.cooldown,
  ghostSpeed: KD.KINDS.ghost.speed(), ghostClawCooldown: null, trollClawCooldown: null, skillMin: QS.SKILL_MIN,
  ...C.traitDefaults(),
  ...Object.fromEntries(Object.entries(SK.skillDefaults()).filter(([k]) => /^(treeGiant|wolf)/.test(k))),
  // P3
  ...BR.explorerBrainSnapshot(), ...PE.explorerPerceptionSnapshot(), ...EN.explorerEncounterSnapshot(), ...CF.confidenceSnapshot(),
  // P4
  ...AB.adversaryBrainSnapshot(), ...AP.adversaryPerceptionSnapshot(), ...AM.adversaryMemorySnapshot(), ...AV.adversaryViewSnapshot(),
  // P5
  ...EM.explorerMemorySnapshot(), ...AM.adversaryLimitsSnapshot(), ...AT.attackSnapshot(),
  // P6: text knobs are null in the registry (= the built-in wording)
  ...Object.fromEntries(R.KNOBS.filter((k) => k.type === 'text').map((k) => [k.key, null])),
  // P8
  ...MR.moraleSnapshot(),
  // levels
  ...KD.levelsSnapshot(),
  // P7
  ...JV.jevSnapshot(),
  // the retreat-redirect arm: the literal is the default of the `progress` option of Run's constructor (src/turn.js)
  explorerProgress: /confidence = false, progress = (true|false) \} = \{\}\) \{/.exec(readFileSync(new URL('../src/turn.js', import.meta.url), 'utf8'))?.[1] === 'true',
  ...Object.fromEntries(Object.entries(UI_CONST).map(([n, c]) => [`ui_${n}`, uiLiteral(c)])),
  // the step-delay slider's starting value lives in index.html, not app.js
  ui_stepDelayMs: Number(/id="delay"[^>]*value="(\d+)"/.exec(readFileSync(new URL('../public/index.html', import.meta.url), 'utf8'))?.[1]),
};
check(KD.KINDS.ghost.skills === 'ghost' && Object.keys(KD.KINDS.ghost.tuning()).length === 0, 'the ghost kind starts with the plain ghost set and no tuning');
check(KD.KINDS.troll.tuning().claw_strike.cooldown === undefined, 'the troll kind inherits the global claw cooldown by default');
check(D.SPAWN_STEPS === ADV.MIN_SPAWN_STEPS, 'dungeon.js and adversary.js agree on the spawn distance');
const allByKey = new Map(R.KNOBS.map((k) => [k.key, k]));
for (const [key, lit] of Object.entries(LIT)) check(eq(allByKey.get(key)?.def, lit), `${key}: registry default ${allByKey.get(key)?.def} != module literal ${lit}`);
check(R.KNOBS.filter((k) => k.page === false).length === Object.keys(LIT).length, 'every file-only knob has a literal check');
check(L.SCHEMA.every((s) => R.KNOBS.find((k) => k.key === s.key).page !== false), 'file-only knobs are not on the settings page');
const sig = (seed) => { const d = generateDungeon(seed); return JSON.stringify([d.width, d.height, d.start, d.treasure, d.tiles.join(''), d.props.length, d.decor.length]); };
const baseline = [11, 12, 13, 14].map(sig);

// 2. the template parses back to the defaults, with no warning
const tpl = L.templateYaml();
const t = L.parseConfig(YAML.parse(tpl));
check(t.warnings.length === 0, 'template has no warnings: ' + t.warnings.join('; '));
const d = L.defaults();
for (const k of Object.keys(d)) check(eq(t.values[k], d[k]), `template value ${k}: ${t.values[k]} != ${d[k]}`);
check(Object.keys(t.presets).length === C.SPECIAL_IDS.length && t.mix === 'mixed', 'template carries every character preset and the mix');
check(/ min: 25 +# /.test(tpl), 'template has inline comments');

// 3. layers: file < instances.<kind> < instances.<kind/name>; instance blocks have the file's shape
const layered = YAML.parse(`
explorer: { lives: 3 }
monsters: { global: { speed: 0.8 } }
instances:
  arena: { explorer: { lives: 4 } }
  arena/a1: { explorer: { lives: 5 }, nonsense: {} }
`);
let p = L.parseConfig(layered, []);
check(p.values.lives === 3 && p.values.speed === 0.8, 'file layer');
p = L.parseConfig(layered, ['arena']);
check(p.values.lives === 4 && p.values.speed === 0.8, 'kind layer overrides the file');
p = L.parseConfig(layered, ['arena', 'arena/a1']);
check(p.values.lives === 5, 'named instance overrides the kind');
check(p.warnings.some((w) => w.startsWith('nonsense')), 'an unknown section is reported');

// 4. bad entries warn with their path and are skipped
p = L.parseConfig(YAML.parse('explorer: { lives: 99, graceTicks: "x" }\nworld: { nonsense: 1 }\nmonsters: { kinds: { ghost: { weight: -1 } } }'));
check(!('lives' in p.values) && !('graceTicks' in p.values), 'bad values are skipped');
check(p.warnings.some((w) => w.startsWith('explorer.lives')) && p.warnings.some((w) => w.startsWith('explorer.graceTicks')), 'bad values name their path');
check(p.warnings.some((w) => w.startsWith('world.nonsense')), 'unknown key named');
check(p.warnings.some((w) => w.includes('monsters.kinds.ghost.weight')), 'negative weight rejected');
p = L.parseConfig(YAML.parse('monsters: { kinds: { ghost: { weight: 0 }, troll: { weight: 0 } } }'));
check(p.warnings.some((w) => w.includes('cannot both be 0')) && !('trollShare' in p.values), 'both weights 0 rejected');
p = L.parseConfig(YAML.parse('monsters: { kinds: { ghost: { weight: 1 }, troll: { weight: 3 } } }'));
check(p.values.trollShare === 0.75, 'weights 1:3 give a troll share of 0.75');
p = L.parseConfig(YAML.parse('monsters: { kinds: { troll: { weight: 1 } } }'));
check(p.values.trollShare === 0.57, 'one weight uses the other default (0.75): 1 / 1.75 = 0.57, got ' + p.values.trollShare);
check(L.parseConfig(7).warnings.length === 1, 'a non-mapping file warns');

// 5. cross-field: the page's validate and the file
let threw = false;
try { L.validate({ minSize: 80, maxSize: 30 }, d); } catch { threw = true; }
check(threw, 'validate rejects min > max map side');

// 6. runtime: a file, a broken file, instance sparse overrides
const cfg = join(dir, 'c.yaml');
process.env.JEV_CONFIG = cfg;
writeFileSync(cfg, 'explorer: { lives: 3 }\nmonsters: { characters: { presets: { timid: { aggression: 3 } } } }\n');
const own = join(dir, 'own.json');
await S.loadSettings(new URL('file://' + own));
check(S.view().values.lives === 3, 'runtime loads the file');
check(C.PRESETS.timid.traits[0] === 3, 'a character preset override reaches character.js');
writeFileSync(cfg, 'explorer: { lives: 6 }\n');
await new Promise((r) => setTimeout(r, 20));
check((await S.refresh()) === true && S.view().values.lives === 6, 'an edit is picked up by mtime');
check(C.PRESETS.timid.traits[0] === 1, 'removing a preset override restores the built-in preset');
await new Promise((r) => setTimeout(r, 20));
writeFileSync(cfg, 'explorer: { lives: [');
await S.refresh();
check(S.view().values.lives === 6 && S.view().central.warnings.length === 1, 'a broken file keeps the last good values and warns');
await new Promise((r) => setTimeout(r, 20));
writeFileSync(cfg, 'explorer: { lives: 3 }\n');
await S.refresh();
await S.saveSettings({ lightRadius: 9 });
let own1 = JSON.parse(readFileSync(own, 'utf8'));
check(own1._sparse === true && own1.lightRadius === 9 && !('lives' in own1), 'the instance file stores only what differs from the central layers');
await new Promise((r) => setTimeout(r, 20));
writeFileSync(cfg, 'explorer: { lives: 2 }\nworld: { lightRadius: 4 }\n');
await S.refresh();
check(S.view().values.lives === 2 && S.view().values.lightRadius === 9, 'a later file edit reaches the instance except for its own override');
writeFileSync(cfg, 'world: { size: { min: 80, max: 30 } }\n');
await new Promise((r) => setTimeout(r, 20));
await S.refresh();
check(S.view().values.minSize <= S.view().values.maxSize, 'an inconsistent file is ignored, not applied');

// 6b. P1 knobs change the world as asked, and defaults change nothing
check(JSON.stringify([11, 12, 13, 14].map(sig)) === JSON.stringify(baseline), 'applying the defaults leaves every generated dungeon identical');
writeFileSync(cfg, 'world: { layout: maze, hearts: { respawn: 50 }, rooms: { min: 6, max: 9, minCount: 4 }, props: { clusters: { max: 0 }, kinds: { fountain: { weight: 0 } } } }\nmonsters: { spawn: { minSteps: 12 } }\ntestbed: { size: { w: 7, h: 9 }, numAdversaries: 2, props: few }\n');
await new Promise((r) => setTimeout(r, 20));
await S.refresh();
await S.applyNextGame();
check(D.ROOM_MIN === 6 && D.ROOM_MAX === 9 && D.SPAWN_STEPS === 12 && ADV.MIN_SPAWN_STEPS === 12, 'world and spawn knobs reach dungeon.js and adversary.js');
check(D.HEART_RESPAWN === 50, 'world.hearts.respawn reaches dungeon.js');
check(CAT.CLUSTER_MAX === 0 && CAT.KINDS.fountain.weight === 0, 'prop knobs reach the catalog');
const roomsOk = [21, 22, 23, 24, 25].every((seed) => generateDungeon(seed).rooms.every((r) => r.w >= 6 && r.w <= 9 && r.h >= 6 && r.h <= 9));
check(roomsOk, 'room sizes follow world.rooms.min/max');
check([21, 22, 23].every((seed) => !generateDungeon(seed).props.some((p) => p.solid)), 'clusters.max 0 gives no solid props');
check(JSON.stringify(TB.DEFAULTS.size) === '[7,9]' && TB.DEFAULTS.numAdversaries === 2 && TB.DEFAULTS.props === 'few', 'testbed defaults follow testbed.*');
writeFileSync(cfg, 'world: { props: { kinds: { shelf: { weight: 0 }, crates: { weight: 0 }, storage_chest: { weight: 0 } } } }\n');
await new Promise((r) => setTimeout(r, 20));
await S.refresh();
check(S.view().central.warnings.some((w) => w.includes('solid prop')) && CAT.KINDS.shelf.weight === 3, 'a file that zeroes every solid prop kind is ignored with a warning');
writeFileSync(cfg, 'explorer: { lives: 2 }\n');
await new Promise((r) => setTimeout(r, 20));
await S.refresh();
await S.applyNextGame();
check(D.ROOM_MIN === 4 && CAT.CLUSTER_MAX === 3 && CAT.KINDS.fountain.weight === 1 && TB.DEFAULTS.props === 'none' && D.SPAWN_STEPS === 20 && D.HEART_RESPAWN === 200, 'removing the keys restores every default');
check(JSON.stringify([11, 12, 13, 14].map(sig)) === JSON.stringify(baseline), 'and the dungeons are the baseline again');

// 6c. P2: skills, kinds and character tables follow the file; bad lists are refused
writeFileSync(cfg, `explorer: { skills: [claw_strike] }
monsters:
  kinds:
    ghost: { speed: 0.5, clawCooldown: 4 }
    troll: { clawCooldown: 0, skills: [claw_strike, sword_strike] }
  characters: { traits: { chaseRange: [3, 9, 9], homeRadius: [10, 20, null] }, lonerHearing: 5 }
skills: { minProbability: 0.7 }
`);
await new Promise((r) => setTimeout(r, 20));
await S.refresh();
await S.applyNextGame();
check(eq(LD.buildSkillSet('explorer').skills.map((k) => k.id), ['claw_strike']), 'explorer.skills changes the explorer set');
check(KD.KINDS.ghost.speed() === 0.5 && KD.KINDS.ghost.tuning().claw_strike.cooldown === 4, 'ghost speed and claw cooldown follow the file');
check(KD.KINDS.troll.tuning().claw_strike.cooldown === 0 && KD.KINDS.troll.tuning().claw_strike.damage === 2, 'troll claw cooldown 0 is honoured (not treated as unset) and its damage stays');
check(eq(KD.KINDS.troll.skills, ['claw_strike', 'sword_strike']), 'troll skills follow the file');
check(C.profileOf(C.traitsOf('aggressive')).chaseRange === 9 && C.profileOf(C.traitsOf('timid')).chaseRange === 3, 'trait table chaseRange follows the file');
check(C.profileOf(C.traitsOf('timid')).answersCallsWithin === 5 && C.profileOf(C.traitsOf('rover')).homeRadius === null && C.profileOf(C.traitsOf('ambusher')).homeRadius === 10, 'home radius and loner hearing follow the file');
check(QS.SKILL_MIN === 0.7, 'skills.minProbability reaches the skill question');
p = L.parseConfig(YAML.parse('explorer: { skills: [sword_strike, sword_strike] }\nmonsters: { kinds: { troll: { skills: [fireball] } , ghost: { skills: [claw_strike, claw_strike, sword_strike, shield_block, sword_strike] } }, characters: { traits: { chaseRange: [1, 2] } } }'));
check(p.warnings.length === 4 && !('explorerSkills' in p.values) && !('trollSkills' in p.values) && !('trait_chaseRange' in p.values), 'duplicate, unknown, too long and wrong-length lists are refused: ' + p.warnings.join(' | '));
writeFileSync(cfg, 'explorer: { lives: 2 }\n');
await new Promise((r) => setTimeout(r, 20));
await S.refresh();
await S.applyNextGame();
check(eq(LD.buildSkillSet('explorer').skills.map((k) => k.id), ['sword_strike', 'shield_block', 'fire_strike', 'dash']) && QS.SKILL_MIN === 0.5 && KD.KINDS.ghost.speed() === 1 && C.profileOf(C.traitsOf('timid')).chaseRange === 5, 'removing the keys restores the P2 defaults');

// 6d. P3: the explorer's thresholds, confidence model and moods follow the file; inconsistent ones are refused
writeFileSync(cfg, `explorer:
  brain: { holdMax: 7, reviewEvery: 12, ghostsCanAttack: false }
  perception: { zoneRecent: 25 }
  encounter: { holdGap: 3 }
  confidence:
    history: { hit: -12, dispelled: 10 }
    panic: { enter: 15, exit: 30 }
    bands: { dominant: 90 }
  moods:
    wary: { minGap: 5, endTicks: 7 }
    tiers: { low: [guarded, wary] }
`);
await new Promise((r) => setTimeout(r, 20));
await S.refresh();
check(BR.explorerBrainSnapshot().brainHoldMax === 7 && BR.explorerBrainSnapshot().brainReviewEvery === 12 && BR.explorerBrainSnapshot().brainGhostsCanAttack === false, 'brain thresholds follow the file (live: no new game needed)');
check(PE.explorerPerceptionSnapshot().percZoneRecent === 25 && EN.explorerEncounterSnapshot().encHoldGap === 3, 'perception and encounter thresholds follow the file');
check(CF.WEIGHTS.hit === -12 && CF.WEIGHTS.dispelled === 10 && CF.D_HIT === -12, 'confidence event weights follow the file');
check(CF.createConfidence() && CF.band(85) === 'sure' && CF.band(90) === 'dominant', 'confidence bands follow the file');
check(CF.panicNext(17, false) === false && CF.panicNext(12, false) === true && CF.panicNext(28, true) === true && CF.panicNext(31, true) === false, 'panic enter/exit follow the file');
check(BR.profileOf({ sentiment: { id: 'wary' } }).min_gap === 5 && BR.profileOf({ sentiment: { id: 'wary' } }).end_ticks === 7, 'mood min_gap and end_ticks follow the file');
check(eq(CF.TIER_MOODS.low, ['guarded', 'wary']) && eq(CF.allowedMoods(10), ['guarded', 'wary']), 'tier mood lists (and their order) follow the file');
p = L.parseConfig(YAML.parse('explorer: { confidence: { panic: { enter: 30, exit: 20 }, tiers: { lowMax: 80, highMin: 70 }, bands: { dominant: 50 } }, moods: { tiers: { mid: [] } } }'));
check(p.warnings.length === 1 && p.warnings[0].includes('explorer.moods.tiers.mid'), 'an empty tier is refused by name: ' + p.warnings.join(' | '));
writeFileSync(cfg, 'explorer: { confidence: { panic: { enter: 30, exit: 20 } } }\n');
await new Promise((r) => setTimeout(r, 20));
await S.refresh();
check(S.view().central.warnings.some((w) => w.includes('Panic')) && CF.confidenceSnapshot().confPanicEnter === 20, 'a file with panic exit below enter is ignored with a warning');
writeFileSync(cfg, 'explorer: { lives: 2 }\n');
await new Promise((r) => setTimeout(r, 20));
await S.refresh();
const sortedEntries = (o) => JSON.stringify(Object.entries(o).sort(([a], [b]) => (a < b ? -1 : 1)));
const nowP3 = { ...BR.explorerBrainSnapshot(), ...PE.explorerPerceptionSnapshot(), ...EN.explorerEncounterSnapshot(), ...CF.confidenceSnapshot() };
check(sortedEntries(nowP3) === sortedEntries(Object.fromEntries(Object.entries(LIT).filter(([k]) => k in nowP3))), 'removing the keys restores every P3 default');

// 6d'. cornerMode (PLAN-corner): a live choice knob, default off; a file value reaches the brain, a bad one is refused, removing it restores off
check(BR.explorerBrainSnapshot().cornerMode === 'off' && R.KNOBS.find((k) => k.key === 'cornerMode')?.options.join() === 'off,urgent,ascii,route,full', 'cornerMode defaults to off and offers off, urgent, ascii, route, full');
writeFileSync(cfg, 'explorer: { brain: { cornerMode: full } }\n');
await new Promise((r) => setTimeout(r, 20));
await S.refresh();
check(BR.explorerBrainSnapshot().cornerMode === 'full', 'cornerMode follows the file (live)');
p = L.parseConfig(YAML.parse('explorer: { brain: { cornerMode: sideways } }'));
check(p.warnings.length === 1 && p.warnings[0].includes('explorer.brain.cornerMode') && !('cornerMode' in p.values), 'a bad cornerMode is refused by name: ' + p.warnings.join(' | '));
writeFileSync(cfg, 'explorer: { lives: 2 }\n');
await new Promise((r) => setTimeout(r, 20));
await S.refresh();
check(BR.explorerBrainSnapshot().cornerMode === 'off', 'removing cornerMode restores off');

// 6d''. explorerProgress (phase 4 A/B arm): file-only toggle, default true, applies from the next game; gameOpts() reads it
check(R.KNOBS.find((k) => k.key === 'explorerProgress')?.def === true && S.appliedValue('explorerProgress') === true && !L.SCHEMA.some((r) => r.key === 'explorerProgress'), 'explorerProgress defaults to true, is file-only');
writeFileSync(cfg, 'explorer: { progress: { redirect: false } }\n');
await new Promise((r) => setTimeout(r, 20));
await S.refresh();
check(S.appliedValue('explorerProgress') === true && S.view().values.explorerProgress === false, 'explorerProgress false waits for the next game');
await S.applyNextGame();
check(S.appliedValue('explorerProgress') === false, 'explorerProgress false applies from the next game');
p = L.parseConfig(YAML.parse('explorer: { progress: { redirect: maybe } }'));
check(p.warnings.length === 1 && p.warnings[0].includes('explorer.progress.redirect') && !('explorerProgress' in p.values), 'a non-boolean explorerProgress is refused by name: ' + p.warnings.join(' | '));
writeFileSync(cfg, 'explorer: { lives: 2 }\n');
await new Promise((r) => setTimeout(r, 20));
await S.refresh();
await S.applyNextGame();
check(S.appliedValue('explorerProgress') === true, 'removing explorerProgress restores true');

// 6e. P4: the monsters' own numbers follow the file (live); a cut-off range that is backwards is refused
writeFileSync(cfg, 'monsters: { brain: { pingpongs: 5, skillNear: 6 }, perception: { sweepRadius: 15, cutMin: 4, cutMax: 30 }, memory: { sightingSpacing: 5 }, pack: { heardSteps: 9 } }\n');
await new Promise((r) => setTimeout(r, 20));
await S.refresh();
const nowP4 = { ...AB.adversaryBrainSnapshot(), ...AP.adversaryPerceptionSnapshot(), ...AM.adversaryMemorySnapshot(), ...AV.adversaryViewSnapshot() };
check(nowP4.advPingpongs === 5 && nowP4.advSkillNear === 6 && nowP4.advSweepRadius === 15 && nowP4.advCutMin === 4 && nowP4.advCutMax === 30 && nowP4.advSightingSpacing === 5 && nowP4.advHeardSteps === 9, 'monster brain, perception, memory and view numbers follow the file');
p = L.parseConfig(YAML.parse('monsters: { perception: { cutMin: 20, cutMax: 5 } }'));
const crossed = L.crossProblems({ ...L.defaults(), ...p.values });
check(crossed.some((w) => w.includes('cut-off')), 'cutMin above cutMax is a cross-field problem');
writeFileSync(cfg, 'explorer: { lives: 2 }\n');
await new Promise((r) => setTimeout(r, 20));
await S.refresh();
const backP4 = { ...AB.adversaryBrainSnapshot(), ...AP.adversaryPerceptionSnapshot(), ...AM.adversaryMemorySnapshot(), ...AV.adversaryViewSnapshot() };
check(sortedEntries(backP4) === sortedEntries(Object.fromEntries(Object.entries(LIT).filter(([k]) => k in backP4))), 'removing the keys restores every P4 default');

// 6f. P5: limits apply from the next game; cross-rules keep memory valid
writeFileSync(cfg, 'limits: { explorer: { events: 9, directive: 200 }, monster: { events: 7 }, skillFactMax: 100, priorityLine: 120 }\nplayer: { maxChars: 140 }\n');
await new Promise((r) => setTimeout(r, 20));
await S.refresh();
check(EM.LIMITS.events === 6 && AM.LIMITS.events === 5, 'limits wait for the next game (memory is validated against them)');
await S.applyNextGame();
check(EM.LIMITS.events === 9 && EM.LIMITS.directive === 200 && AM.LIMITS.events === 7 && AT.attackSnapshot().limSkillFact === 100 && C.PRIORITY_MAX === 120, 'limits follow the file from the next game');
const crossLim = L.crossProblems({ ...L.defaults(), limExplorer_directive: 100 });
check(crossLim.some((w) => w.includes('directive')), 'a directive limit below the directive length setting is refused');
check(L.crossProblems({ ...L.defaults() }).length === 0 && L.defaults().helpReachSteps === 48 && L.defaults().helpReachSteps > L.defaults().alertSteps, 'helpReachSteps defaults to 48, above the pack alert reach');
check(L.crossProblems({ ...L.defaults(), helpReachSteps: 24 }).some((w) => w.includes('helpReachSteps')), 'helpReachSteps not above alertSteps is refused');
check(L.crossProblems({ ...L.defaults(), limMonster_moves: 4 }).some((w) => w.includes('recent-moves')), 'a monster memory limit below a character trait level is refused');
check(L.crossProblems({ ...L.defaults(), limExplorer_recentCells: 7 }).some((w) => w.includes('recentCells')), 'recentCells below recentMoves + 2 is refused');
writeFileSync(cfg, 'explorer: { lives: 2 }\n');
await new Promise((r) => setTimeout(r, 20));
await S.refresh();
await S.applyNextGame();
const backP5 = { ...EM.explorerMemorySnapshot(), ...AM.adversaryLimitsSnapshot(), ...AT.attackSnapshot(), limPriorityLine: C.PRIORITY_MAX };
check(sortedEntries(backP5) === sortedEntries(Object.fromEntries(Object.entries(LIT).filter(([k]) => k in backP5))), 'removing the keys restores every P5 default');
check(REQUEST_BYTES.explorerChasing === 9500 && REQUEST_BYTES.explorerPatrolling === 10500 && REQUEST_BYTES.adversaryMax === 8000, 'the request-size bounds the checks use are the documented ones');

// 6g. P6: prompt wording. null/absent = built-in; the file replaces it; bad text is refused
const builtins = { ...BR.explorerPromptDefaults(), ...C.characterPromptDefaults(), ...AM.monsterPromptDefaults(), ...QS.skillPromptDefaults(), ...TX.thoughtDefaults(), ...EN.explorerRemarkDefaults() };
const textRows = R.KNOBS.filter((k) => k.type === 'text');
check(textRows.length === Object.keys(builtins).length && textRows.every((k) => k.key in builtins), 'every text knob has a built-in wording, and every built-in has a knob');
check(textRows.every((k) => k.def === null && (k.len || k.list ? Array.isArray(builtins[k.key]) : typeof builtins[k.key] === 'string')), 'text knobs default to null and the built-ins have the right shape');
check(textRows.every((k) => (k.len || k.list ? builtins[k.key].every((x) => x.length <= k.maxLen) : builtins[k.key].length <= k.maxLen)), 'no built-in wording exceeds its own limit');
check(textRows.filter((k) => k.list).every((k) => builtins[k.key].length >= k.minLen && builtins[k.key].length <= k.maxItems), 'every built-in bubble pool fits its own size range');
check(Object.keys(TH.THOUGHTS).length + Object.keys(TH.MOOD_THOUGHTS).length + Object.keys(TH.TROLL_THOUGHTS).length + Object.keys(TH.TREE_GIANT_THOUGHTS).length + Object.keys(TH.WOLF_THOUGHTS).length + Object.keys(EN.explorerRemarkDefaults()).length === textRows.filter((k) => k.list).length, 'every bubble pool in thoughts.js has a knob and vice versa');
const moduleWording = () => ({ ...BR.explorerPromptSnapshot(), ...C.characterPromptSnapshot(), ...AM.monsterPromptSnapshot(), ...QS.skillPromptSnapshot() });
const builtinsOfModules = () => Object.fromEntries(Object.entries(builtins).filter(([k]) => k in moduleWording()));
check(sortedEntries(moduleWording()) === sortedEntries(builtinsOfModules()), 'with no config every module speaks its built-in wording');
writeFileSync(cfg, `explorer:
  moods:
    wary: { when: "Custom wary when.", gloss: careful }
  prompts:
    triggers: { start: "Custom start." }
    tacticHints: { hide: "Custom hide." }
    confidenceSentence: " Custom caps."
skills: { questionText: { neutral: { question: "Pick one skill, maybe." } } }
monsters:
  characters:
    lines: { aggression: [A1, A2, A3] }
    words: { pack: [x, y, z] }
  prompts: { objective: "Custom objective." }
`);
await new Promise((r) => setTimeout(r, 20));
await S.refresh();
check(BR.SENTIMENTS.wary.when === 'Custom wary when.' && BR.explorerPromptSnapshot().moodGloss_wary === 'careful' && BR.SENTIMENTS.wary.note === builtins.mt_wary_note, 'mood wording follows the file and leaves the other fields alone');
check(BR.explorerPromptSnapshot().trigger_start === 'Custom start.' && BR.explorerPromptSnapshot().tacticHint_hide === 'Custom hide.' && BR.CAPS_SENTENCE === ' Custom caps.', 'trigger, tactic-hint and confidence wording follow the file (live)');
check(QS.skillQuestion({ k: { fact: 'f' } }, '', { neutral: true }).instructions.question.startsWith('Pick one skill, maybe.'), 'the skill question uses the file wording');
check(C.profileOf(C.traitsOf('aggressive')).priority.includes('A3') && C.profileOf(C.traitsOf('timid')).words.pack === 'x', 'character lines and trait words follow the file');
check(AM.OBJECTIVE === 'Custom objective.', 'the monster objective follows the file');
p = L.parseConfig(YAML.parse(`explorer:
  moods: { bold: { when: "" }, steady: { note: "two\\nlines" } }
  prompts: { triggers: { hit: ${JSON.stringify('x'.repeat(900))} } }
monsters: { characters: { words: { pack: [a, b] }, lines: { strike: ["", "ok", ""] } } }`));
check(p.warnings.length === 4 && !('mt_bold_when' in p.values && p.values.mt_bold_when) && p.values.line_strike?.[1] === 'ok', 'empty, multi-line, too long and wrong-length wording is refused by name, empty level lines are allowed: ' + p.warnings.join(' | '));
const same = L.parseConfig(YAML.parse(`explorer: { prompts: { triggers: { start: ${JSON.stringify(builtins.trigger_start)} } } }`));
check(same.values.trigger_start === null && same.warnings.length === 0, 'text equal to the built-in is not an override');
writeFileSync(cfg, 'explorer: { lives: 2 }\n');
await new Promise((r) => setTimeout(r, 20));
await S.refresh();
check(sortedEntries(moduleWording()) === sortedEntries(builtinsOfModules()), 'removing the keys restores every built-in wording');

// 6h. P7: the Jev client, the browser's share
check(Object.values(UI_CONST).every((c) => uiLiteral(c) !== undefined), 'every ui constant is found in app.js');
writeFileSync(cfg, `jev: { hedgeCopies: 3, hedgeDelayMs: 500, retries: 1, timeoutMs: 5000, retryStatus: [429], model: jev-test }
ui:
  walkMs: 900
  revealAlpha: 0.5
  thoughts:
    troll: { struck: ["OW!", "AGH!"] }
    mood: { bold: [Onward] }
`);
await new Promise((r) => setTimeout(r, 20));
await S.refresh();
const jv = JV.jevSnapshot();
check(jv.jevHedgeCopies === 3 && jv.jevHedgeDelayMs === 500 && jv.jevRetries === 1 && jv.jevTimeoutMs === 5000 && eq(jv.jevRetryStatus, [429]) && jv.jevModel === 'jev-test' && JV.jevModel() === 'jev-test', 'the Jev client follows the file (live)');
const ui = S.uiView();
check(ui.constants.walkMs === 900 && ui.constants.revealAlpha === 0.5 && ui.constants.camMs === 120, 'api/ui carries the timing constants');
check(eq(ui.thoughts.troll.struck, ['OW!', 'AGH!']) && eq(ui.thoughts.mood.bold, ['Onward']) && Object.keys(ui.thoughts.approach).length === 0 && !('hit' in ui.thoughts.troll), 'api/ui carries only the bubble pools the file overrides');
p = L.parseConfig(YAML.parse('jev: { hedgeCopies: 9, model: "Bad Model!", retryStatus: [200] }\nui: { thoughts: { mood: { bold: [] , wary: [a, a] }, troll: { hit: [' + JSON.stringify('x'.repeat(70)) + '] } } }'));
check(p.warnings.length === 6, 'out-of-range, malformed, empty, repeated and too long entries are each refused by name: ' + p.warnings.join(' | '));
writeFileSync(cfg, 'explorer: { lives: 2 }\n');
await new Promise((r) => setTimeout(r, 20));
await S.refresh();
const back = JV.jevSnapshot();
check(back.jevHedgeCopies === 1 && back.jevModel === 'jev-latest' && eq(back.jevRetryStatus, [429, 502, 503, 504, 529]) && Object.keys(S.uiView().thoughts.troll).length === 0 && S.uiView().constants.walkMs === 620, 'removing the keys restores the Jev client and the browser defaults');

// Decision provider switching and removal use the same live config hooks as Jev.
writeFileSync(cfg, 'decision: { provider: laya, laya: { endpoint: "http://localhost:8100/v1/systemone", model: local-test, maxLen: 4096, headMaxLen: 2048, timeoutMs: 180000 } }\n');
await new Promise((r) => setTimeout(r, 20));
await S.refresh();
const local = JV.jevSnapshot();
check(local.decisionProvider === 'laya' && local.layaEndpoint === 'http://localhost:8100/v1/systemone' && local.layaModel === 'local-test' && local.layaMaxLen === 4096 && local.layaHeadMaxLen === 2048 && local.layaTimeoutMs === 180000 && JV.jevModel() === 'local-test', 'local decision provider and model follow the file live');
writeFileSync(cfg, 'explorer: { lives: 2 }\n');
await new Promise((r) => setTimeout(r, 20));
await S.refresh();
const resetProvider = JV.jevSnapshot();
check(resetProvider.decisionProvider === 'jev' && resetProvider.layaEndpoint === 'http://127.0.0.1:8000/v1/systemone' && resetProvider.layaModel === 'multilingual' && resetProvider.layaMaxLen === 8192 && resetProvider.layaHeadMaxLen === 1024 && resetProvider.layaTimeoutMs === 120000 && JV.jevModel() === 'jev-latest', 'removing provider knobs restores hosted defaults and all local defaults');

// 6i. CONFIG.md is generated from the registry and must be current
writeFileSync(cfg, 'decision: { provider: openai, openai: { model: gpt-6-luna, timeoutMs: 45000 } }\n');
await new Promise((r) => setTimeout(r, 20));
await S.refresh();
check(JV.jevSnapshot().decisionProvider === 'openai' && JV.jevSnapshot().openaiDecisionTimeoutMs === 45000 && JV.jevModel() === 'gpt-6-luna', 'OpenAI provider and timeout follow the file live');
writeFileSync(cfg, 'explorer: { lives: 2 }\n');
await new Promise((r) => setTimeout(r, 20));
await S.refresh();
check(JV.jevSnapshot().decisionProvider === 'jev' && JV.jevSnapshot().openaiDecisionModel === 'gpt-6-luna' && JV.jevSnapshot().openaiDecisionTimeoutMs === 30000, 'removing OpenAI knobs restores the provider and OpenAI defaults');

check(readFileSync(fileURLToPath(new URL('../CONFIG.md', import.meta.url)), 'utf8') === L.docsMarkdown(), 'CONFIG.md is up to date (run: node scripts/config.mjs docs --write)');

// 7. userSetting: every category has the flag, the scope shows only flagged knobs
for (const [name, c] of Object.entries(R.CATEGORIES)) check(typeof c.userSetting === 'boolean', `category ${name} has userSetting`);
for (const k of R.KNOBS) {
  const c = k.path && R.categoryOf(k.path);
  check(k.path === null || c !== null, `${k.key} sits in a category`);
  check(typeof R.isUserSetting(k) === 'boolean', `${k.key} resolves userSetting`);
}
const userKeys = R.KNOBS.filter(R.isUserSetting).map((k) => k.path ?? k.key).sort().join(',');
check(userKeys === 'explorer.lives,player.cooldownS,player.enabled,player.maxChars,player.steps', 'player-visible knobs: ' + userKeys);
check(S.userView().schema.length === 5 && Object.keys(S.userView().values).length === 5, 'user view lists only flagged knobs');
let status = null;
try { await S.saveUserSettings({ speed: 1 }); } catch (err) { status = err.status; }
check(status === 403, 'user scope refuses an unflagged knob with 403');
await S.saveUserSettings({ 'player.steps': 30 });
check(S.view().values.injectSteps === 30, 'user scope saves a flagged knob by path');
check(JSON.parse(readFileSync(own, 'utf8')).injectSteps === 30, 'and writes it to the instance file');


// 9. monster levels (PLAN-levels.md): knobs reach kinds.js, off = level 2 and today's stats, the draw stays in range and its own stream
{
  const tmpl = L.parseConfig(YAML.parse(L.templateYaml()));
  check(tmpl.values.levelsEnabled === true && eq(tmpl.values.levelHpMult, [0.5, 1, 1.5, 2]) && eq(tmpl.values.levelWeightTroll, [1, 1]), 'levels: template carries the defaults');
  const bad = L.parseConfig(YAML.parse('monsters: { levels: { hpMult: [1, 2], weights: { ghost: [1, -1] } } }'));
  check(bad.warnings.length === 2, 'levels: a short hpMult tuple and a negative weight warn: ' + bad.warnings.join('; '));
  const good = L.parseConfig(YAML.parse('monsters: { levels: { enabled: false, hpMult: [1, 2, 3, 4], dmgMult: [2, 2, 2, 2], weights: { ghost: [0, 1], troll: [1, 0] } } }'));
  check(good.warnings.length === 0 && good.values.levelsEnabled === false && eq(good.values.levelHpMult, [1, 2, 3, 4]), 'levels: a file sets the knobs');
  const seeds = Array.from({ length: 500 }, (_, i) => i + 1);
  const kinds8 = ['ghost', 'troll', 'ghost', 'troll', 'ghost', 'troll', 'ghost', 'troll'];
  const draws = seeds.map((s) => KD.assignLevels(s, kinds8));
  check(draws.every((l) => l.every((v, i) => KD.LEVEL_RANGE[kinds8[i]].includes(v))), 'levels: ghost 1-2, troll 2-3 over 500 seeds');
  check(draws.flat().includes(1) && draws.flat().includes(3), 'levels: both ends are drawn');
  check(eq(KD.assignLevels(7, kinds8), KD.assignLevels(7, kinds8)), 'levels: same seed, same levels');
  check(JSON.stringify(KD.levelStats('ghost', 2)) === JSON.stringify({ hp: 2, clawDamage: 1 }) && JSON.stringify(KD.levelStats('troll', 2)) === JSON.stringify({ hp: 4, clawDamage: 2 }), 'levels: level 2 is today\'s base');
  check(JSON.stringify(KD.levelStats('ghost', 1)) === JSON.stringify({ hp: 1, clawDamage: 1 }) && JSON.stringify(KD.levelStats('troll', 3)) === JSON.stringify({ hp: 6, clawDamage: 3 }), 'levels: ghost L1 and troll L3 stats');
  const mk = (kind, level) => new ADV.Adversary({ id: 'a1', pos: [1, 1], kind, level });
  check(mk('troll', 3).level === 3 && mk('troll', 3).clawDamage === 3 && mk('troll', 3).maxHp === 6, 'levels: an Adversary carries level, clawDamage and the level hp');
  check(mk('ghost', 1).maxHp === 1 && mk('ghost', 1).skills.skills[0].damage === 1 && mk('ghost').level === 2 && mk('troll').level === 2, 'levels: default level 2; hp matches');
  let threw = false; try { mk('ghost', 5); } catch { threw = true; }
  check(threw, 'levels: level 5 throws');
  // another stream: kinds and spawn cells do not depend on the level knobs
  const dg = generateDungeon(21);
  const spawnSig = () => JSON.stringify(ADV.spawnAdversaries(dg).map((a) => [a.id, a.pos, a.kind]));
  const onSig = spawnSig();
  KD.configureLevels({ levelHpMult: [3, 3, 3, 3], levelWeightGhost: [0, 1], levelWeightTroll: [1, 0] });
  check(spawnSig() === onSig, 'levels: weights and multipliers never move spawns or kinds');
  check(KD.assignLevels(5, ['ghost', 'troll']).join() === '2,2', 'levels: weights [0,1] / [1,0] pin ghost 2 and troll 2');
  KD.configureLevels({ levelWeightGhost: [0, 0] });
  check(KD.assignLevels(5, ['ghost']).every((v) => v === 1 || v === 2), 'levels: all-zero weights fall back to even');
  KD.configureLevels({ levelsEnabled: false });
  check(ADV.spawnAdversaries(dg).every((a) => a.level === KD.defaultLevel(a.kind)) && JSON.stringify(KD.levelStats('troll', 3)) === JSON.stringify({ hp: 4, clawDamage: 2 }) && mk('troll', 3).level === 2 && mk('troll', 3).maxHp === 4, 'levels: off = all level 2, today\'s hp and claw');
  check(mk('tree_giant', 1).level === 4 && mk('wolf', 4).level === 2 && KD.assignLevels(1, ['tree_giant', 'wolf']).join() === '4,2', 'levels: fixed kinds keep level 4/2 with scaling disabled');
  KD.configureLevels({ levelsEnabled: true, levelHpMult: [0.5, 1, 1.5, 2], levelWeightGhost: [1, 1], levelWeightTroll: [1, 1] });
  // testbed
  const arena = (levels, extra = {}) => TB.buildArena({ size: [9, 9], numAdversaries: 4, kinds: ['ghost', 'troll'], levels, ...extra }).adversaries;
  check(arena(undefined).every((a) => a.level === KD.defaultLevel(a.kind)), 'levels: testbed default is level 2');
  check(arena([1, 3]).map((a) => a.level).join() === '1,3,1,3', 'levels: testbed list is cycled');
  check(arena('random').every((a) => KD.LEVEL_RANGE[a.kind].includes(a.level)), 'levels: testbed random stays in range');
  check(arena(3)[1].maxHp === 6 && arena(3)[1].clawDamage === 3 && arena(2)[1].clawDamage === 2 && arena(3)[0].clawDamage === 2, 'levels: testbed troll claws like a real one (troll claw 2 x mult: L2 2, L3 3; ghost L3 2) with 6 hp at level 3');
  let tbBad = false; try { arena(5); } catch (e) { tbBad = e instanceof TB.TestbedError; }
  check(tbBad, 'levels: testbed rejects level 5');
}
console.log(failed ? `${failed} check(s) failed` : 'All config checks passed.');
process.exit(failed ? 1 : 0);
