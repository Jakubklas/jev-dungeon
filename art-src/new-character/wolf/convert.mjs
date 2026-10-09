// Rebuild the string-grid source and the preview; copy constants into public/sprites.js.
import { fileURLToPath } from 'node:url';
import { writeFileSync } from 'node:fs';
import { convertSheet, toJs, writePreview } from '../../../scripts/img2sprite.mjs';

const source = fileURLToPath(new URL('./wolf-height-1.png', import.meta.url));
const result = await convertSheet(source, { grid: [3, 1], rows: ['poses'], height: 20, colors: 20 });
result.palette.o = '#181a28'; // shared ghost/bone outline
result.anchorX = 13;
result.anchorY = 19;
writeFileSync(new URL('./converted.js', import.meta.url), toJs('wolf', result, 'wolf-height-1.png'));
writePreview(fileURLToPath(new URL('./preview.png', import.meta.url)), result);
console.log(result.report);
