// Run from any directory: node art-src/new-props/portal/build.mjs
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { convertSheet, decode, toJs, writePreview } from '../../../scripts/img2sprite.mjs';

const source = decode(fileURLToPath(new URL('./portal-sprite-sheet.jpg', import.meta.url)));
// Remove the printed row labels and register the stone arches in equal slots.
const width = 220 * 4, height = 270 * 3;
const data = new Uint8Array(width * height * 4).fill(255);
const xs = [80, 330, 580, 830], ys = [32, 338, 656];
for (let row = 0; row < 3; row++) for (let col = 0; col < 4; col++) {
  // The source's arches shift left slightly in each subsequent row.
  const x0 = xs[col] - row * 6;
  for (let y = 0; y < 270; y++) for (let x = 0; x < 220; x++) {
    const from = ((ys[row] + y) * source.width + x0 + x) * 4;
    const to = ((row * 270 + y) * width + col * 220 + x) * 4;
    data.set(source.data.subarray(from, from + 4), to);
  }
}
const result = await convertSheet({ width, height, data }, {
  grid: [4, 3], rows: ['idle', 'opening', 'shimmer'], height: 48, colors: 32,
});
const target = fileURLToPath(new URL('../../../public/sprites.js', import.meta.url));
const start = '// BEGIN GENERATED PORTAL';
const end = '// END GENERATED PORTAL';
const block = `${start}\n// Regenerate: node art-src/new-props/portal/build.mjs\n${toJs('portal', result, 'art-src/new-props/portal/portal-sprite-sheet.jpg')}\n${end}\n`;
let text = readFileSync(target, 'utf8');
if (text.includes(start)) text = text.slice(0, text.indexOf(start)) + block + text.slice(text.indexOf(end) + end.length + 1);
else text = text.replace('// Raw art data (DOM-free)', `${block}\n// Raw art data (DOM-free)`);
writeFileSync(target, text);
writePreview(fileURLToPath(new URL('./preview.png', import.meta.url)), result, 5);
console.log(result.report);
