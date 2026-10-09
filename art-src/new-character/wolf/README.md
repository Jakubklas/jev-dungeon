# Wolf sprite

Run `node art-src/new-character/wolf/convert.mjs` from the repo root to recreate `converted.js` and `preview.png` using the existing image converter. It removes the source's white background, scales the three-column sheet to 20 art pixels high (the ghost's height), reduces it to 20 colours and applies the shared ghost/bone outline.

`public/sprites.js` contains the generated palette and poses. Columns 1, 2 and 3 are the rest, stride and biting attack poses. The `wolf` entry uses pose 1 as idle, poses 1/2 for walking and poses 1/3 for the attack wind-up/bite. Registration is `(13, 19)`. All frames share a 27×20 canvas; a quadruped is naturally wider than the 18×20 upright ghost.
