// Central config (src/config/): registry defaults against the old SCHEMA, the YAML template round trip, layering,
// cross-field rules, bad-entry warnings, a broken file, the userSetting flag and the user scope. Free, no Jev, no network.
// Never reads the real central-config.yaml: JEV_CONFIG is set to scratch files before the modules load.
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
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
  ['roomsPerHeart', 4, 'next'],
  ['maxHearts', 6, 'next'],
  ['coinDropChance', 0.6, 'next'],
  ['stunTicks', 2, 'next'],
  ['lives', 2, 'next'],
  ['lightRadius', 7, 'next'],
  ['minSize', 25, 'next'],
  ['maxSize', 90, 'next'],
  ['roomArea', 290, 'next']
];

// 1. registry vs the old schema
check(OLD.length === 39, `frozen list has 39 rows, got ${OLD.length}`);
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
  roomMin: D.ROOM_MIN, roomMax: D.ROOM_MAX, minRooms: D.MIN_ROOMS, loopShare: D.LOOP_SHARE, loopMin: D.LOOP_MIN, treasureShare: D.TREASURE_SHARE,
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
  ghostSpeed: KD.KINDS.ghost.speed(), ghostClawCooldown: null, trollClawCooldown: null, skillMin: QS.SKILL_MIN,
  ...C.traitDefaults(),
  // P3
  ...BR.explorerBrainSnapshot(), ...PE.explorerPerceptionSnapshot(), ...EN.explorerEncounterSnapshot(), ...CF.confidenceSnapshot(),
  // P4
  ...AB.adversaryBrainSnapshot(), ...AP.adversaryPerceptionSnapshot(), ...AM.adversaryMemorySnapshot(), ...AV.adversaryViewSnapshot(),
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
  arena/a1: { explorer: { lives: 5 }, limits: {} }
`);
let p = L.parseConfig(layered, []);
check(p.values.lives === 3 && p.values.speed === 0.8, 'file layer');
p = L.parseConfig(layered, ['arena']);
check(p.values.lives === 4 && p.values.speed === 0.8, 'kind layer overrides the file');
p = L.parseConfig(layered, ['arena', 'arena/a1']);
check(p.values.lives === 5, 'named instance overrides the kind');
check(p.warnings.some((w) => w.startsWith('limits')), 'an unknown section is reported');

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
writeFileSync(cfg, 'world: { rooms: { min: 6, max: 9, minCount: 4 }, props: { clusters: { max: 0 }, kinds: { fountain: { weight: 0 } } } }\nmonsters: { spawn: { minSteps: 12 } }\ntestbed: { size: { w: 7, h: 9 }, numAdversaries: 2, props: few }\n');
await new Promise((r) => setTimeout(r, 20));
await S.refresh();
await S.applyNextGame();
check(D.ROOM_MIN === 6 && D.ROOM_MAX === 9 && D.SPAWN_STEPS === 12 && ADV.MIN_SPAWN_STEPS === 12, 'world and spawn knobs reach dungeon.js and adversary.js');
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
check(D.ROOM_MIN === 4 && CAT.CLUSTER_MAX === 3 && CAT.KINDS.fountain.weight === 1 && TB.DEFAULTS.props === 'none' && D.SPAWN_STEPS === 20, 'removing the keys restores every default');
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
check(eq(LD.buildSkillSet('explorer').skills.map((k) => k.id), ['sword_strike', 'shield_block']) && QS.SKILL_MIN === 0.5 && KD.KINDS.ghost.speed() === 1 && C.profileOf(C.traitsOf('timid')).chaseRange === 5, 'removing the keys restores the P2 defaults');

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

console.log(failed ? `${failed} check(s) failed` : 'All config checks passed.');
process.exit(failed ? 1 : 0);
