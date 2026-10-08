# STYLE_GUIDELINES.md: Jev Dungeon visual style

Read this before you draw, recolour or animate anything in `public/`. It describes the look the user wants and how the code makes it. AGENTS.md covers game rules; this file covers pixels.

## The style in six rules

1. **Hand-placed pixels, never smoothed.** Every sprite is a string grid (one character = one art pixel) plus a palette. Nothing is antialiased, rotated or scaled by a fraction. Curves (shadows, glows, the slash) are drawn pixel by pixel (`pixelEllipse`, `drawSlash`). The whole scene renders into a low-res buffer, blitted at an integer scale with smoothing off.
2. **Reuse the shared colour ramps.** Steel, bone, wood and ghost cloth each have one ramp, shared by every asset made of that material (see [Palette](#palette)). Copy these hex values exactly. Don't invent near-matches.
3. **Outline each sprite in a dark, hue-tinted colour, never pure black.** Wood is outlined in `#1e0f05`, steel in `#172531`, bone and ghosts in `#181a28`. The outline is 1 px and sits outside the shape.
4. **Light is a world effect, not a property of the art.** Author art at full brightness. The renderer pulls every non-emissive colour toward cold navy in the dark bands (`bandPalette`). Pixels that emit light (flames, water, embers) go in the sprite's `emissive` list. Never pre-darken art.
5. **The scene is cold navy stone, warmed by amber where the knight has walked.** Saturated colour is saved for meaning: red for the knight's plume and cape, for danger and for the claw; gold for loot and the shield; blue-white for the sword; cyan for "Jev brain on".
6. **Motion is small and discrete:**
   - 2-frame idles at 260 ms.
   - Hovering is a 2 px bob.
   - Moves are 150 ms tweens.
   - Effects come in a handful of frames (the slash has 6) and then they're gone.

   Nothing spins, scales or blurs.

## Reference assets (the canon)

The user picked these as the best expression of the style. Match them when you make anything new.

| Asset | Where | Size (art px) | Why it's the reference |
| --- | --- | --- | --- |
| Knight (explorer) | `public/sprites.js` `KNIGHT_A` / `KNIGHT_B` | 18×24, anchor (9, 23) | A steel ramp of 4 tones plus a red accent; a readable silhouette (plume, visor slit, shield arm, cape) at tiny size; a breathing frame built by shifting rows |
| Ghost (adversary) | `public/sprites.js` `GHOST_A` / `GHOST_B` | 18×20, anchor (9, 19) | A hooded cloth ramp, a bone skull face and one glowing red eye pixel per socket; a ragged hem that alternates between the two frames |
| Troll | `public/sprites.js` `TROLL_A` / `TROLL_B` | 22×22 (two wall blocks), anchor (11, 21) | A hunched brute built from its own green ramp plus the shared bone, wood and steel ramps: moss-spiked back, fanged jaw with two tusks, hanging fists, belt with buckle; the breathing frame drops one row under the head. Art only, not placed in the game yet. Preview next to the knight and ghost: [docs/troll-preview.png](docs/troll-preview.png) |
| Sword slash | `public/app.js` `drawSlash`, `SLASH_COLORS` | Arc radius 13 to 26 | A per-pixel crescent: thin tail, fat leading head, a 4-tone ramp from a dark rim to a white core |
| Floor tiles | `public/app.js` `stonePattern`, `PALETTE.floor*`, `mortar` | 32×16 diamond | Flagstones, cobbles or a cracked slab; 1 px mortar; a lit top-left bevel and a dark bottom-right bevel per stone; sparse pixel noise |
| Storage chest | `public/props/floor-art.js` `makeChest` | 24×23 | An iso box with a separate lid, two steel bands that wrap over the lid, a lock plate, a keyhole pixel and rivets |
| Shelf | `floor-art.js` `makeShelf` | 24×30 | An iso box seen from the open side; 3 tiers of tiny stamped goods (jars, sack, bottle, bowls) |
| Crates | `floor-art.js` `makeCrates` | 25×30 | Two stacked crates (light and dark variants) with frame and plank lines, plus a barrel with iron bands |
| Bones | `floor-art.js` `makeSkull` | 20×12 | A 7×7 skull on two crossed bones that run along the iso axes; bone shares the ghost's palette |

**Not the reference.** The forge, fountain, goblet, anvil and all wall decor (torch, fireplace, arch, gate, banner) use a second family: purple stone ramps (`#9983b3` / `#745d92` / `#4b3b62`) and a `#1b1223` outline. They are accepted in the game but are not a template. When they conflict with the canon, follow the canon. The `CHEST_A` sprite in `sprites.js` is **never drawn on the board**: the goal cell draws the fire portal (`drawPortal`), so don't copy that chest. The reference chest is `storage_chest`.

## Palette

### Shared material ramps (copy these exactly)

Ramps are listed dark → light. The character in brackets is the palette key the reference file uses.

| Material | Outline | Ramp | Used by |
| --- | --- | --- | --- |
| **Steel** | `#172531` | `#3f5b6f` (D) · `#6f8fa5` (M) · `#abbfce` (L) · `#edf3f7` (W) | Knight armour, `STEEL_PAL` (tools, sword prop) |
| **Wood** | `#1e0f05` | `#2d1608` (k, deep shadow) · `#603312` (w) · `#93531f` (W) · `#c4782e` (L) · `#df9b4a` (h, highlight) | `WOOD` (shelf, crates, storage chest), the sprites.js chest, forge bellows, fireplace logs, the steel-prop handles |
| **Bone** | `#181a28` | `#13131f` (k, socket) · `#b6a96e` (E/B, shade) · `#e3daa7` (e/b, bone) · `#f4eecb` (h, highlight) | Ghost face, `BONE_PAL` (skull) |
| **Ghost cloth** | `#181a28` | `#414762` (d) · `#666f95` (g) · `#9aa1bc` (l) · `#cacfde` (h, hood highlight) | Ghost |
| **Iron bands** (cool blue-grey, on wood) | wood outline | `#3c5476` (s) · `#708eb2` (S) · `#aec4dc` (t) | Chest bands and lock, barrel hoops |
| **Clay** | wood outline | `#54291c` (d) · `#844530` (c) · `#ad6242` (C) | Jars, pots |
| **Glazed blue** | wood outline | `#1f2c61` (b) · `#344994` (B) · `#657fce` (n) | Jars, pots (`#131a3c` deep shade on pots) |
| **Sack** | wood outline | `#634c25` (Z) · `#957437` (A) · `#c49e56` (a) | Shelf sack |
| **Glass** | wood outline | `#51987a` (g) · `#85c9a8` (G) | Shelf bottle |
| **Troll skin** | `#101a0e` | `#172b14` (m, moss) · `#25401f` (d) · `#3f6a2b` (g) · `#5f8f3c` (l) · `#8fb85a` (h, belly and brow) | Troll. Eyes use the coin gold `#ffc633`; teeth, tusks and the belt trinket the bone ramp; belt and loincloth the wood ramp; buckle the steel ramp |

### Accents (saturated, meaningful, used sparingly)

| Meaning | Colours | Where |
| --- | --- | --- |
| Knight red (plume, cape, belt) | `#750b0f` shade · `#d11920` | `KNIGHT_PAL` r / R |
| Ghost eye | `#ff3b30` (one pixel per socket) | `GHOST_PAL` e |
| Danger / enemy / claw strike | `#ff4a3a` (`PALETTE.enemy`, chase glow, hp pips), `#ff3a2c` (`STRIKE_COLOR` diamonds) | app.js |
| Gold / loot | `#ffc633` · `#fff0a8` · `#c98a14`, outline `#3a2406` | `COIN_PAL`, coin glow |
| Shield (block) | steel rim (the Steel ramp `#3f5b6f` · `#6f8fa5` · `#abbfce` · `#edf3f7`, outline `#172531`) round a coin-gold face (`#c98a14` · `#ffc633` · `#fff0a8`); blocked diamonds `#8fb4ff` | `SHIELD_COLORS`, `BLOCK_COLOR` |
| Jev brain on | `#7ee8ff` on `#082c36` | `PALETTE.brain` / `brainEdge` |
| Trail | `#ffd98c` at alpha .38 | `PALETTE.trail` |

### Slash ramps (rim → core)

| Attacker | Tones | 
| --- | --- |
| Sword (explorer) | `#2a2392` · `#5b4fe0` · `#a9a4ff` · `#ffffff` |
| Claw (ghost) | `#6b0f12` · `#c22a2a` · `#ff8f80` · `#fff1ea` |
| Shield spark (blocked claw) | `#c98a14` · `#ffc633` · `#fff0a8` · `#ffffff` (the coin ramp) |

### World ramps: stone, light and fog

The world materials have three stops each: **cold** (dimly lit edge) → **mid** → **warm** (where the knight walked). `ramp(name, band)` interpolates them over `BANDS = 8` light bands.

| Material | Cold | Mid | Warm |
| --- | --- | --- | --- |
| `floor` | `#172547` | `#463d61` | `#bc7a34` |
| `floorHi` (stone bevel, light) | `#1e3161` | `#574b77` | `#dd9f51` |
| `floorLo` (stone bevel, dark) | `#121e3c` | `#373150` | `#9d6225` |
| `mortar` | `#0a1126` | `#211c33` | `#5b3313` |
| `wallTop` | `#2a4478` | `#675987` | `#dda35a` |
| `wallTopHi` | `#3f5fa1` | `#8976a6` | `#facb82` |
| `wallL` (left face) | `#1a2a50` | `#463959` | `#975c2a` |
| `wallR` (right face, darker) | `#101a38` | `#2e263f` | `#633a1a` |
| `wallMortar` | `#080e21` | `#191527` | `#3b210b` |

- **Fog** (unknown cells, by distance 1-5 from the nearest known cell): `#0e1937`, `#0b142c`, `#090f22`, `#060a19`, `#050710`.
- **Void:** `#04050d`.
- **Shadows:** `rgba(0, 0, 0, .45)`.

The cold band target for props (`navy` in `buildProps`) is the floor's cold stop, `PALETTE.floor[0]` = `#172547`, so a crate in a dark corner sinks into the stone instead of glowing.

### UI chrome (`public/style.css`)

Dark only: `--bg #070913`, `--panel #0e162a`, `--panel-2 #131e3a`, `--ink #ede4cb`, `--muted #7e89b5`, `--line #202e56`, `--line-hi #2c3d72`, `--accent #f5a42f`. The chrome uses:

- square corners (`border-radius: 0`);
- 2 px borders;
- hard offset shadows (`3px 3px 0 #000`, no blur);
- a monospace font;
- buttons that press in by 2 px.

The page's colours echo the canvas: navy panels and amber accent.

## Geometry and sizes

| What | Value | Code |
| --- | --- | --- |
| Floor tile | 32×16 art px diamond; row r spans 2(r+1) px each side of centre | `TW`, `TH`, `inDiamond` |
| Iso slope | 2:1 (2 px across, 1 px down). In prop art, 16 art px per cell side | `isoX = (x-y)·16`, `isoY = (x+y)·8` |
| Wall block | 11 px tall; walls are 1 or 2 blocks (25% are 2) | `WALL_H`, `MAX_BLOCKS`, `TALL_WALL_SHARE` |
| Wall courses | 4 px courses (mortar every 4th row), vertical joints staggered by 3 px | wall builder in app.js |
| Characters | Knight 18×24, ghost 18×20, troll 22×22 (two wall blocks); the anchor is the feet or hover point, on the cell centre | `ART` in sprites.js |
| Small floor props | About 18-20 × 12-16 (skull 20×12, tools/sword 20×14, anvil 18×12, goblet 12×16) | floor-art.js |
| Solid floor props | About 24-25 × 23-30, roughly one cell's diamond wide (chest 24×23, shelf 24×30, crates 25×30) | floor-art.js |
| Coin | 7×7 | `COIN_A` |
| Wall decor | At most 14×19, front view, bottom row on the floor line | wall-art.js header |
| Shield overlay | 15×14 hand-placed heater shield (steel rim with rivets, gold face, steel boss on a centre seam), top 13 px above the feet | `SHIELD_ROWS`, `drawShield` |
| Hp pips | 2×2 fill in a 4×4 dark frame, 4 px apart | `drawEntity` |
| Shadows | Pixel ellipse 6×2 under the knight and ghosts, 4×1 under coins | `pixelEllipse` |

**Scale reference.** A solid prop fills one cell and stands about one wall block tall (shelf: 17 px box height). A character is about 2 blocks tall. Small props are 12-16 px tall, about half to two-thirds of the knight's 24 px.

## Construction techniques

### Sprite format

```js
const PAL = { o: '#1e0f05', w: '#603312', W: '#93531f', L: '#c4782e' };
const ART = [
  '.oooo.',
  'oLLLLo',
  'oWWWwo',
  '.oooo.',
];
```

- `.` is transparent. One letter is one colour. Use the same letters as the reference palettes:
  - outline `o`;
  - steel `D/M/L/W`;
  - wood `w/W/L/h`;
  - bone `e/E/h`, socket `k`.
- **Art faces right.** The renderer mirrors it around `anchorX` for left-facing and `flip: true`. Don't author a left-facing version.
- **Anchor** = the pixel that sits on the cell centre: the feet for the knight, the hover point for a ghost, the footprint centre for props.
- Keep art **DOM-free** (plain arrays and objects) so node can import and check it. Canvases are made only in `buildSprites` / `buildProps`.

### Iso props (floor-art.js)

Build solid props from the `Layer` painter rather than typing big grids:

- `box(L, u0, w0, a, b, z0, h, { top, topEdge, left, right })` draws an iso box in cell coordinates: `u` along "\", `w` (depth) along "/", `z` height, 16 px per cell side.
  - `lf(u, v)` and `rf(s, v)` return the pixel at column u/s, height v on the left or right face, so details land on the face's slope.
  - `topEdge` is a 1 px lighter lip on the top's front edge. Every reference box uses one.
- `barrel`, `vase` and `ell` draw rounded forms row by row.
- `stamp(rows, cx, yb)` drops a tiny hand-made grid (a jar, a sack, the skull) at a bottom-centre point.
- `merge(layer, 'o')` composites each part with **its own 1 px outline**. This is how stacked parts stay readable (the crate on the crate, the barrel beside them). `merge(layer, 'o', true)` adds only a drop-shadow outline under the shape, which is how flat bones and tools lie on the floor.
- `finish(L, 8, 8)` crops to the art and sets the anchor at the cell centre.
- Solid props are authored for `flip: false`: backed onto a wall at the upper right of the cell, front face toward the lower left.

**Shading in the reference props.** The light source differs per asset, so match the asset you are closest to:

- **Crates and chest:** top lightest (`L` with an `h` or `L` lip), left face `W`, right face `w` (the dark variant shifts every face one step darker). Frame lines are 1 px on the edges, planks every 3 px.
- **Shelf:** the top is `L` with an `h` lip. The open front (left face) is the dark interior `k` behind light `L` uprights and boards. The right side panel is `W`.
- **Barrel:** the lit column is on the left, mid `W` in the middle, and the right third is shaded `w`. Iron hoops are 2 px, `S` on the left half and `s` on the right.
- **Knight:** the helmet is lit from the upper left (`W` and `L` there) with `M` on its right edge.
- **Ghost:** the cloth runs dark `d` at the trailing left edge to light `l` / `h` on the hood's right, toward the face.
- **Floor stones and wall caps:** lit on the top-left edges and shaded on the bottom-right edges.

**Detail density.** Each solid reference prop carries two or three small story details made of 1-2 px marks: the chest's lock plate with a keyhole pixel and corner rivets, the shelf's jars and bottle, the crate's plank lines. Detail never comes from noise or gradients.

### Floor and wall tiles (app.js)

- Three stone patterns, two variants each (`FLOOR_VARIANTS = 6`): 2×2 flagstones, 3×3 offset cobbles and a single cracked slab. The variant per cell comes from `hash(x, y)`.
- Every tile uses five tones: none, mortar, dark, base, light. Each stone has a 1 px mortar line, a light inner bevel on its top-left edges and a dark one on its bottom-right edges. Stone tone comes from a per-stone hash (30% dark, 18% light). There are also about 6% random flecked pixels.
- Wall faces: the left face is lighter than the right, with 4 px brick courses and staggered joints. Each lower block is a little darker than the one above, the front corner column catches light, and the cap is a rim pattern (lit top edges).
- Tiles are pre-rendered once per band into caches. Add new tile types the same way, never per frame.
- **Fog of war in the renderer.** Never draw an unknown wall or read `tiles` for an unknown cell unless Reveal is on (AGENTS.md, Server & UI).

### Light bands

- `bandOf(light)` maps a cell's light to one of 8 bands. World tiles use `ramp()`, and props use `bandPalette`: `keep = .3 + .7·t` pulls each colour toward navy, so band 0 keeps 30% of the authored colour.
- Colours listed in a sprite's `emissive` keep full strength in every band. Use this for flames, water, embers and glowing glass, and nothing else.
- Newly lit cells fade in over `FADE_MS = 300`. A cell below light .2 is drawn with alpha `s / .2`.

### Glows and effects

- **Glow** = 2-3 concentric `pixelEllipse` rings drawn with `globalCompositeOperation = 'lighter'` at alpha about .05 / .07 / .10, ry = .85·rx. Wall lights also add a flat floor pool (rx·1.1 by rx·.55).
  - Flicker: `.8 + .12·sin(now/110 + phase) + .08·sin(now/47 + 3·phase)`.
  - Glow colours: warm `#ffa43c` / `#ff8a2a` / `#ff9a3a` / `#ffb458`, magic and water `#4aa3ff`.
  - Glows are visual only. They never feed `game.light` or the fog.
- **Slash** (`drawSlash`):
  - Swept around the attacker's cell (`strike.from`) toward the centroid of the struck cells.
  - The arc spans 2.3 rad and is drawn in 6 discrete frames.
  - The half-width swells from about 1.5 px at the tail to about 7.5 px at the head.
  - The tail catches up late, so the crescent thins out.
  - Tone thresholds by distance from the centre line: >.72 core white (only past 25% of the arc), >.45, >.2, then the rim.
  - The swing is mirrored for cuts toward the screen's left.
  - The last 2 frames are drawn at .55 alpha; a miss at .6.
  - Drawn in the `edge` pass, after the entities, and only on lit cells.
- **Strike diamonds:** a filled diamond in the flats pass plus a 1 px rim in the edge pass. They are held for half of `STRIKE_MS`, pulse twice and then fade.
- **Portal** (goal cell): a per-pixel ring of fire built from the `FIRE_COLS` ramp `#6e1409` → `#fffbe0`. Flame wisps curl off it, embers rise and a floor glow pools under it. It hovers like the coins.

## Animation

| Motion | Timing | Code |
| --- | --- | --- |
| Idle frame swap (knight breathing, ghost hem) | 2 frames, `ANIM_MS = 260` | `frameOf` |
| Ghost hover | ±2 px sine over 1600 ms; the shadow shrinks by 1 px when the ghost rises | `BOB_PX`, `BOB_MS` |
| Move between cells | 150 ms smoothstep tween; a jump of more than one cell snaps | `TWEEN_MS` |
| Facing | Sign of the change in screen x: right/up faces right, left/down faces left; mirrored around `anchorX` | AGENTS.md, facing rule |
| Chase glow | 3 red rings, pulse `.75 + .25·sin(now/180)` | `drawEntity` |
| Sword / claw slash | 340 ms, 6 frames | `SLASH_MS` |
| Strike diamonds | 800 ms (hold 50%, 2 pulses, fade) | `STRIKE_MS`, `STRIKE_HOLD` |
| Shield block spark | 200 ms, 4 frames: white-hot cross, tight ring, broken wide ring, scattered sparks (rings are 2:1 iso diamonds on the shield edge toward the attacker). The shield flashes to `SHIELD_FLASH` tones on frames 0 and 2 | `SHIELD_SLASH_MS`, `drawBlockSpark` |
| Hit protection | The knight blinks every 120 ms at alpha .3 | `BLINK_MS` |
| Torch / fireplace / gate | 130 / 150 / 200 ms per frame | `frameMs` in wall-art.js |
| Coins | 1 px bob, `sin(now/380 + cell phase)` | `drawEntity` |
| Coin pickup | 700 ms golden rings plus 4 sparkles drifting up | `COIN_GLOW_MS` |

**Making frames.** Copy the base grid and replace a few rows (`withRows(base, { 2: '...' })`, or `KNIGHT_B`, which drops a row to make the knight breathe). The silhouette must stay identical except for the 1-2 px that move. Give each instance a `phase` so copies don't animate in lockstep.

## Do and don't

**Do**
- Reuse a reference ramp for any steel, wood, bone or cloth.
- Outline each separate part with `merge(..., 'o')` so stacked shapes read.
- Keep detail to 1-2 px marks that tell a story: a keyhole, a rivet, a jar.
- Put light sources in `emissive` and give them a glow entry.
- Keep new art DOM-free, register new `public/` files in `server.js` `STATIC`, and keep the sprite fallbacks working.

**Don't**
- Use pure black (`#000000`) outlines, gradients, blur, `imageSmoothingEnabled = true`, rotation, or fractional scaling of sprites.
- Draw new world materials in the purple stone family. That palette belongs to the wall decor and the forge, not the canon.
- Darken art by hand for shadowed areas. The band system does that.
- Add saturated colour to props without a meaning (danger, loot, magic).
- Draw anything on an unlit cell without the Reveal check.
- Use `rng()` for visual variety. Use `hash(x, y, seed ^ k)` so the dungeon stays deterministic (AGENTS.md rule 8).

## Adding new art: checklist

1. Pick the nearest reference asset and copy its palette keys and ramp.
2. Author it facing right, at full brightness, with a hue-tinted 1 px outline. Fit it to the size class in [Geometry](#geometry-and-sizes).
3. For an iso prop, build it from `box` / `barrel` / `stamp` in floor-art.js, `merge` each part with its outline, then call `finish(L, 8, 8)`.
4. List emissive keys and a `glow` if it gives off light. Add `frameMs` if it animates.
5. Check it in node (`node -e "import('./public/props/floor-art.js').then(m => console.log(m.FLOOR_ART.<kind>.frames[0].join('\n')))"`), then look at it in the browser on page load (free; don't press Start). The screenshot recipe is in AGENTS.md, Run & verify.
6. If you change a value listed here, update this file: code beats docs (AGENTS.md rule 3).
