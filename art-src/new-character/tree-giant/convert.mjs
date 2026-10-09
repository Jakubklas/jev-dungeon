// Rebuild the string-grid source and the preview; copy constants into public/sprites.js.
import { fileURLToPath } from 'node:url';
import { writeFileSync } from 'node:fs';
import { convertSheet, toJs, writePreview } from '../../../scripts/img2sprite.mjs';

const source = fileURLToPath(new URL('./tree-giant-sprite-height-3.png', import.meta.url));
const result = await convertSheet(source, { grid: [3, 1], rows: ['poses'], height: 72, colors: 32 });
result.palette.o = '#1e0f05'; // shared wood outline: no near-black outline
result.anchorX = 27; // trunk centre; the converter's lowest root alone sits left of it
result.anchorY = 71;
writeFileSync(new URL('./converted.js', import.meta.url), toJs('tree_giant', result, 'tree-giant-sprite-height-3.png'));
writePreview(fileURLToPath(new URL('./preview.png', import.meta.url)), result);
console.log(result.report);
