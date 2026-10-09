# Tree giant sprite

Run `node art-src/new-character/tree-giant/convert.mjs` from the repo root to recreate `converted.js` and `preview.png` using the existing image converter. It removes the source's white background, scales the three-column sheet to 72 art pixels high (three 24-pixel character blocks), reduces it to 32 colours and applies the shared dark wood outline.

`public/sprites.js` contains the generated palette and poses. Columns 1, 2 and 3 are the rest, stride and reaching attack poses. The `tree_giant` entry uses pose 1 as idle, poses 1/2 for walking and poses 1/3 for the attack wind-up/reach. Registration is `(27, 71)`, under the trunk rather than the leftmost root. All frames share a 65×72 canvas so the reaching arm does not change sprite geometry during animation.
