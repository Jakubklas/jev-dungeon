// The knob registry: every central setting once. Data only, imports nothing (PLAN-central-config.md).
//   key     the flat name the game modules, the instance's settings.json, the settings page and the hub CLI use
//   path    where the knob lives in central-config.yaml (null = not a file key; trollShare is derived from the kind weights)
//   group, label, hint   the settings page; doc is the one-line comment written next to it in the YAML
//   when    'live' applies the moment it is saved, 'next' from the next game
//   page    false = not on the settings page (only in the YAML, the CLI and the API); default true
//   userSetting  may a player-facing UI list it? Inherited from the category (CATEGORIES) unless the knob says so; default false.
// Adding a knob = adding a row here (and wiring its key in the module it tunes).

// A category is a YAML path prefix. The longest matching prefix decides the default for its knobs.
export const CATEGORIES = {
  world: { userSetting: false, doc: 'Dungeon layout, light, coins and hearts. Developer only.' },
  explorer: { userSetting: false, doc: 'The knight: lives and protection after a hit.' },
  skills: { userSetting: false, doc: 'Sword, shield and the stun they cause.' },
  monsters: { userSetting: false, doc: 'Ghosts and trolls: speed, packs, spawn, stats, characters.' },
  player: { userSetting: true, doc: 'Directives the player may whisper to the explorer.' },
  testbed: { userSetting: false, doc: 'Defaults of the small test arenas (gyms).' },
};

const PAGE_ROWS = [
  { key: 'speed', path: 'monsters.global.speed', group: 'Adversaries', label: 'Speed', hint: 'Fraction of the explorer\'s speed (1 = as fast).', doc: 'Monster speed as a share of the explorer (1 = same speed)', type: 'range', min: 0.1, max: 1, step: 0.05, def: 0.6, when: 'live' },
  { key: 'chaseRange', path: 'monsters.global.chaseRange', group: 'Adversaries', label: 'Chase range', hint: 'Cells within which a seen explorer starts a hunt.', doc: 'Cells within which a seen explorer starts a hunt', type: 'range', min: 1, max: 12, step: 1, def: 7, when: 'live' },
  { key: 'sightRange', path: 'world.sightRange', group: 'Adversaries', label: 'Sight range', hint: 'How far anyone sees along a clear line (both sides).', doc: 'How far anyone sees along a clear line (explorer and monsters)', type: 'range', min: 3, max: 12, step: 1, def: 7, when: 'live' },
  { key: 'maxSearchTicks', path: 'monsters.global.maxSearchTicks', group: 'Adversaries', label: 'Search time', hint: 'Ticks without sight before a ghost gives up.', doc: 'Ticks without sight before a monster gives up', type: 'range', min: 1, max: 60, step: 1, def: 18, when: 'live' },
  { key: 'keepHuntingMin', path: 'monsters.global.keepHuntingMin', group: 'Adversaries', label: 'Give-up threshold', hint: 'Jev\'s keep-hunting answer below this ends the hunt.', doc: 'Jev keep-hunting answer below this ends the hunt (0-1)', type: 'range', min: 0, max: 1, step: 0.05, def: 0.5, when: 'live' },
  { key: 'adversaryCharacters', path: 'monsters.characters.enabled', group: 'Adversaries', label: 'Ghost characters', hint: 'Each ghost gets a fixed character (mixed presets) and its own patrol stream. Off = every ghost is standard.', doc: 'true = each monster gets a personality (see characters); false = all standard', type: 'toggle', def: false, when: 'next' },
  { key: 'limitedMap', path: 'monsters.global.limitedMap', group: 'Adversaries', label: 'Limited ghost map', hint: 'Ghosts know only their home zone and what they have seen (fading), not the real map. Needs Ghost characters; ignored without it.', doc: 'true = monsters only know their home zone and what they saw (needs adversaryCharacters)', type: 'toggle', def: false, when: 'next' },
  { key: 'injectEnabled', path: 'player.enabled', group: 'Player', label: 'Player directives', hint: 'Let the player send the explorer a short instruction (POST /api/inject). Sending costs no Jev call.', doc: 'Player may whisper directives to the explorer', type: 'toggle', def: true, when: 'live', userSetting: true },
  { key: 'injectMaxChars', path: 'player.maxChars', group: 'Player', label: 'Directive length', hint: 'Longest directive in characters (the server enforces it).', doc: 'Longest directive in characters', type: 'range', min: 20, max: 140, step: 10, def: 140, when: 'live', userSetting: true },
  { key: 'injectSteps', path: 'player.steps', group: 'Player', label: 'Directive lifetime', hint: 'Game steps a directive stays live before it expires.', doc: 'Steps a directive stays live', type: 'range', min: 1, max: 100, step: 1, def: 20, when: 'live', userSetting: true },
  { key: 'injectCooldownS', path: 'player.cooldownS', group: 'Player', label: 'Directive cooldown', hint: 'Seconds between two directives (0 = none).', doc: 'Seconds between two directives', type: 'range', min: 0, max: 120, step: 1, def: 10, when: 'live', userSetting: true },
  { key: 'graceTicks', path: 'explorer.graceTicks', group: 'Damage', label: 'Grace after a hit', hint: 'Ticks of protection after a hit.', doc: 'Steps of protection after the explorer is hit', type: 'range', min: 0, max: 12, step: 1, def: 4, when: 'live' },
  { key: 'packAlert', path: 'monsters.pack.alert', group: 'Pack', label: 'Pack alert', hint: 'A spotter calls nearby patrolling ghosts into the hunt.', doc: 'A spotter calls nearby patrolling monsters into the hunt', type: 'toggle', def: true, when: 'live' },
  { key: 'alertSteps', path: 'monsters.pack.alertSteps', group: 'Pack', label: 'Alert reach', hint: 'Path steps within which a call is heard.', doc: 'Path steps within which a call is heard', type: 'range', min: 1, max: 80, step: 1, def: 24, when: 'live' },
  { key: 'teamSight', path: 'monsters.pack.teamSight', group: 'Pack', label: 'Team sight', hint: 'Hunters track the explorer through a packmate\'s eyes.', doc: 'Hunters see the explorer through packmates\' eyes', type: 'toggle', def: true, when: 'live' },
  { key: 'floorPerAdversary', path: 'monsters.spawn.floorPerMonster', group: 'Spawn', label: 'Floor cells per ghost', hint: 'Fewer cells = more ghosts on a map.', doc: 'Floor cells per monster: lower = more monsters', type: 'range', min: 40, max: 1000, step: 10, def: 150, when: 'next' },
  { key: 'trollShare', path: null, group: 'Spawn', label: 'Troll share', hint: 'Chance a spawned monster is a troll instead of a ghost (trolls hunt like ghosts but are slower, tougher and hit harder).', doc: 'Derived from the kind weights (monsters.kinds.*.weight); not a file key', type: 'range', min: 0, max: 1, step: 0.01, def: 0.25, when: 'next' },
  { key: 'maxAdversaries', path: 'monsters.spawn.max', group: 'Spawn', label: 'Max ghosts', hint: '0 = none.', doc: 'Cap on monsters per map (0 = none)', type: 'range', min: 0, max: 24, step: 1, def: 12, when: 'next' },
  { key: 'floorPerCoin', path: 'world.coins.floorPerCoin', group: 'Spawn', label: 'Floor cells per coin', hint: 'Fewer cells = more coins lying around a map.', doc: 'Floor cells per coin: lower = more coins', type: 'range', min: 10, max: 1000, step: 10, def: 60, when: 'next' },
  { key: 'maxCoins', path: 'world.coins.max', group: 'Spawn', label: 'Max coins', hint: 'Coins lying around at the start. 0 = none (ghost drops still happen).', doc: 'Coins lying around at the start (0 = none)', type: 'range', min: 0, max: 100, step: 1, def: 30, when: 'next' },
  { key: 'swordDamage', path: 'skills.sword_strike.damage', group: 'Skills', label: 'Sword damage', hint: 'Hit points a sword strike takes from a ghost.', doc: 'Hit points a sword strike takes', type: 'range', min: 1, max: 3, step: 1, def: 1, when: 'next' },
  { key: 'swordCooldown', path: 'skills.sword_strike.cooldown', group: 'Skills', label: 'Sword cooldown', hint: 'Steps before the sword strike is ready again.', doc: 'Steps before the sword is ready again', type: 'range', min: 0, max: 6, step: 1, def: 1, when: 'next' },
  { key: 'shieldChance', path: 'skills.shield_block.effectiveness', group: 'Skills', label: 'Shield chance', hint: 'Chance a raised shield stops an attack on the explorer.', doc: 'Chance a raised shield stops a claw (0-1)', type: 'range', min: 0, max: 1, step: 0.05, def: 0.6, when: 'next' },
  { key: 'shieldCooldown', path: 'skills.shield_block.cooldown', group: 'Skills', label: 'Shield cooldown', hint: 'Steps before the shield can be raised again.', doc: 'Steps before the shield can be raised again', type: 'range', min: 0, max: 6, step: 1, def: 2, when: 'next' },
  { key: 'clawDamage', path: 'monsters.kinds.ghost.clawDamage', group: 'Skills', label: 'Claw damage', hint: 'Lives a ghost claw strike takes.', doc: 'Lives a ghost claw strike takes.', type: 'range', min: 1, max: 3, step: 1, def: 1, when: 'next' },
  { key: 'clawCooldown', path: 'monsters.global.clawCooldown', group: 'Skills', label: 'Claw cooldown', hint: 'Steps before a ghost can strike again.', doc: 'Steps before a monster can claw again', type: 'range', min: 0, max: 6, step: 1, def: 2, when: 'next' },
  { key: 'ghostHp', path: 'monsters.kinds.ghost.hp', group: 'Skills', label: 'Ghost hit points', hint: 'Hits a ghost takes before it is dispelled.', doc: 'Hits a ghost takes before it is dispelled.', type: 'range', min: 1, max: 5, step: 1, def: 2, when: 'next' },
  { key: 'trollHp', path: 'monsters.kinds.troll.hp', group: 'Skills', label: 'Troll hit points', hint: 'Hits a troll takes before it is dispelled (a ghost has Ghost hit points).', doc: 'Hits a troll takes before it is dispelled (a ghost has Ghost hit points).', type: 'range', min: 1, max: 10, step: 1, def: 4, when: 'next' },
  { key: 'trollClawDamage', path: 'monsters.kinds.troll.clawDamage', group: 'Skills', label: 'Troll claw damage', hint: 'Lives a troll claw strike takes.', doc: 'Lives a troll claw strike takes.', type: 'range', min: 1, max: 3, step: 1, def: 2, when: 'next' },
  { key: 'trollSpeed', path: 'monsters.kinds.troll.speed', group: 'Skills', label: 'Troll speed', hint: 'A troll moves at this share of the ghost speed.', doc: 'A troll moves at this share of the ghost speed.', type: 'range', min: 0.2, max: 1, step: 0.05, def: 0.65, when: 'next' },
  { key: 'roomsPerHeart', path: 'world.hearts.roomsPerHeart', group: 'Spawn', label: 'Rooms per heart', hint: 'One heart (restores a life) per this many rooms, at least one. Hearts are rare.', doc: 'One heart (restores a life) per this many rooms', type: 'range', min: 1, max: 20, step: 1, def: 4, when: 'next' },
  { key: 'maxHearts', path: 'world.hearts.max', group: 'Spawn', label: 'Max hearts', hint: 'Hearts lying around at the start. 0 = none.', doc: 'Cap on hearts per map (0 = none)', type: 'range', min: 0, max: 20, step: 1, def: 6, when: 'next' },
  { key: 'coinDropChance', path: 'world.coins.dropChance', group: 'Skills', label: 'Coin drop chance', hint: 'Chance a dispelled ghost drops a coin.', doc: 'Chance a dispelled monster drops a coin (0-1)', type: 'range', min: 0, max: 1, step: 0.05, def: 0.6, when: 'next' },
  { key: 'stunTicks', path: 'skills.stunTicks', group: 'Skills', label: 'Stun ticks', hint: 'Ticks a struck ghost loses (no step, no Jev call).', doc: 'Ticks a struck monster loses (no move, no Jev call)', type: 'range', min: 0, max: 6, step: 1, def: 2, when: 'next' },
  { key: 'lives', path: 'explorer.lives', group: 'Explorer', label: 'Lives', hint: 'Lives the explorer starts with.', doc: 'Lives the explorer starts with', type: 'range', min: 1, max: 9, step: 1, def: 2, when: 'next', userSetting: true },
  { key: 'lightRadius', path: 'world.lightRadius', group: 'Explorer', label: 'Light radius', hint: 'Cells each visited cell lights up.', doc: 'Cells each visited cell lights up', type: 'range', min: 3, max: 12, step: 1, def: 7, when: 'next' },
  { key: 'minSize', path: 'world.size.min', group: 'Map', label: 'Min map side', hint: 'Smallest width or height.', doc: 'Smallest map side', type: 'range', min: 25, max: 90, step: 1, def: 25, when: 'next' },
  { key: 'maxSize', path: 'world.size.max', group: 'Map', label: 'Max map side', hint: 'Largest width or height.', doc: 'Largest map side', type: 'range', min: 25, max: 90, step: 1, def: 90, when: 'next' },
  { key: 'roomArea', path: 'world.roomArea', group: 'Map', label: 'Cells per room', hint: 'Fewer cells = more, closer rooms.', doc: 'Floor cells per room: lower = more, closer rooms', type: 'range', min: 120, max: 800, step: 10, def: 290, when: 'next' },
];

// ---- P1: world, props, testbed. File-only (page: false); each default is the literal the module used to hold. ----
const num = (key, path, def, min, max, step, doc) => ({ key, path, group: 'World', label: path, hint: doc, doc, type: 'range', min, max, step, def, when: 'next', page: false });
const PROP_KINDS = ['shelf', 'crates', 'storage_chest', 'fountain', 'forge', 'pots', 'skull', 'tools', 'sword', 'anvil', 'goblet', 'fireplace', 'arch', 'gate', 'banner'];
const PROP_WEIGHT_DEF = { shelf: 3, crates: 3, storage_chest: 2, fountain: 1, forge: 1, pots: 3, skull: 2, tools: 2, sword: 1, anvil: 1, goblet: 1, fireplace: 3, arch: 2, gate: 2, banner: 2 };
const P1_ROWS = [
  num('roomMin', 'world.rooms.min', 4, 2, 10, 1, 'Smallest room side, cells'),
  num('roomMax', 'world.rooms.max', 15, 4, 30, 1, 'Largest room side, cells'),
  num('minRooms', 'world.rooms.minCount', 4, 1, 20, 1, 'Fewest rooms a map gets'),
  num('loopShare', 'world.corridors.loopShare', 0.25, 0, 1, 0.05, 'Extra loop corridors as a share of the rooms'),
  num('loopMin', 'world.corridors.loopMin', 2, 0, 10, 1, 'Fewest loop corridors'),
  num('treasureShare', 'world.treasureShare', 0.6, 0, 1, 0.05, 'The portal sits at least this share of the farthest path distance away'),
  num('torchMin', 'world.props.torches.min', 1, 0, 6, 1, 'Fewest wall torches per room'),
  num('torchMax', 'world.props.torches.max', 3, 1, 8, 1, 'Most wall torches per room'),
  num('torchGap', 'world.props.torches.gap', 3, 1, 8, 1, 'Preferred spacing between wall items, cells'),
  num('corridorTorchPerRoom', 'world.props.corridorTorches.perRoom', 0.4, 0, 2, 0.05, 'Expected corridor torches per room'),
  num('corridorTorchGap', 'world.props.corridorTorches.gap', 5, 1, 12, 1, 'Spacing between corridor torches, cells'),
  num('bigMinRun', 'world.props.big.minRun', 6, 3, 20, 1, 'Wall run needed for a fireplace, arch or gate, cells'),
  num('bigChance', 'world.props.big.chance', 0.5, 0, 1, 0.05, 'Chance a long enough room gets a big wall piece'),
  num('clusterSizeMin', 'world.props.clusters.sizeMin', 1, 1, 6, 1, 'Smallest solid prop cluster, cells'),
  num('clusterSizeMax', 'world.props.clusters.sizeMax', 4, 1, 8, 1, 'Largest solid prop cluster, cells'),
  num('clusterPerCells', 'world.props.clusters.perCells', 30, 5, 200, 1, 'About one cluster per this many inner room cells'),
  num('clusterMax', 'world.props.clusters.max', 3, 0, 10, 1, 'Most clusters per room'),
  num('clusterGap', 'world.props.clusters.gap', 2, 1, 5, 1, 'Cells kept between different clusters'),
  num('clusterTries', 'world.props.clusters.tries', 25, 1, 200, 1, 'Placement attempts per room'),
  num('minExits', 'world.props.minExits', 2, 1, 4, 1, 'Floor neighbours each solid prop leaves open'),
  num('forgeRoomChance', 'world.props.forge.roomChance', 0.12, 0, 1, 0.01, 'Chance a big enough room gets a forge'),
  num('forgeMinInner', 'world.props.forge.minInner', 4, 3, 10, 1, 'Room cells inside the edge ring, each way, a forge needs'),
  num('forgeMinArea', 'world.props.forge.minArea', 20, 9, 100, 1, 'Inner room cells a forge needs'),
  num('smallPerCells', 'world.props.small.perCells', 25, 5, 200, 1, 'About one small prop per this many room cells'),
  num('smallMax', 'world.props.small.max', 3, 0, 12, 1, 'Most small props per room'),
  num('corridorSmallPerCells', 'world.props.small.corridorPerCells', 150, 20, 600, 1, 'About one small prop per this many corridor cells'),
  ...PROP_KINDS.map((id) => num(`propWeight_${id}`, `world.props.kinds.${id}.weight`, PROP_WEIGHT_DEF[id], 0, 10, 1, `How often ${id} is picked, relative to its class (0 = never picked at random)`)),
  num('spawnMinSteps', 'monsters.spawn.minSteps', 20, 1, 60, 1, 'Path steps a monster spawns away from the explorer start'),
  { ...num('testbedSizeW', 'testbed.size.w', 11, 3, 60, 1, 'Default arena width, floor cells'), group: 'Testbed' },
  { ...num('testbedSizeH', 'testbed.size.h', 11, 3, 60, 1, 'Default arena height, floor cells'), group: 'Testbed' },
  { ...num('testbedSeed', 'testbed.seed', 1, 0, 4294967295, 1, 'Default arena seed'), group: 'Testbed' },
  { ...num('testbedNumAdversaries', 'testbed.numAdversaries', 1, 0, 8, 1, 'Default monsters per arena'), group: 'Testbed' },
  { ...num('testbedMinGap', 'testbed.minAdversaryGap', 4, 1, 30, 1, 'Default least path distance of a random monster from the start'), group: 'Testbed' },
  { key: 'testbedProps', path: 'testbed.props', group: 'Testbed', label: 'testbed.props', hint: 'Default prop preset', doc: 'Default prop preset: none, few or many', type: 'choice', options: ['none', 'few', 'many'], def: 'none', when: 'next', page: false },
];
export const KNOBS = [...PAGE_ROWS, ...P1_ROWS];

// Kind spawn weights are file-only (relative); trollShare = troll / (ghost + troll) is derived from them.
export const KIND_WEIGHTS = [
  { path: 'monsters.kinds.ghost.weight', def: 0.75, doc: 'Spawn weight, relative to the other kinds (0.75 vs 0.25 = a quarter trolls)' },
  { path: 'monsters.kinds.troll.weight', def: 0.25, doc: 'Spawn weight, relative to the other kinds' },
];

export const categoryOf = (path) => Object.keys(CATEGORIES).filter((c) => path === c || path.startsWith(c + '.')).sort((a, b) => b.length - a.length)[0] ?? null;
export function isUserSetting(row) {
  if (row.userSetting !== undefined) return row.userSetting;
  const c = row.path && categoryOf(row.path);
  return c ? CATEGORIES[c].userSetting : false;
}
