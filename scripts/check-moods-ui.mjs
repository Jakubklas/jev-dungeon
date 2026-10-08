// Checks for the moods' UI side (PLAN-moods): every mood has at least 3 thought-bubble lines of at most 60 characters in
// public/app.js (MOOD_THOUGHTS), a note (SENTIMENT_NOTES) and a tint in public/style.css, with no ghost / adversary wording.
// Reads the files as text (the browser code cannot be imported). Free, no Jev. Run from dungeon-game: node scripts/check-moods-ui.mjs
import { readFileSync } from 'node:fs';
import { SENTIMENTS } from '../src/characters/explorer/brain.js';
import { MOOD_IDS } from '../src/characters/explorer/memory.js';
import { MOOD_THOUGHTS, TROLL_THOUGHTS, THOUGHTS } from '../public/thoughts.js';

let fails = 0;
const ok = (c, m) => { if (!c) { fails++; console.log(`FAIL: ${m}`); } };
const app = readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
const css = readFileSync(new URL('../public/style.css', import.meta.url), 'utf8');
const literal = (name) => {
  const m = new RegExp(`const ${name} = (\\{[\\s\\S]*?\\n\\});`).exec(app);
  ok(!!m, `${name} found in app.js`);
  return m ? Function(`return (${m[1]})`)() : {};
};
const thoughts = MOOD_THOUGHTS; // plain data in public/thoughts.js (the browser imports the same file)
const notes = literal('SENTIMENT_NOTES');
const ids = Object.keys(SENTIMENTS);
ok(MOOD_IDS.join() === ids.join(), `memory MOOD_IDS (${MOOD_IDS}) match SENTIMENTS (${ids})`);
for (const id of ids) {
  const lines = thoughts[id] ?? [];
  ok(lines.length >= 3, `${id}: at least 3 bubble lines (${lines.length})`);
  ok(new Set(lines).size === lines.length, `${id}: bubble lines are unique`);
  for (const l of lines) {
    ok(l.length > 0 && l.length <= 60, `${id}: "${l}" is ${l.length} chars (max 60)`);
    ok(!/ghost|adversar/i.test(l), `${id}: "${l}" says ghost / adversary`);
  }
  ok(typeof notes[id] === 'string' && notes[id].length > 0 && !/ghost|adversar/i.test(notes[id]), `${id}: has a note without ghost / adversary wording`);
  ok(new RegExp(`\\[data-sentiment="${id}"\\]\\s*\\{\\s*--senti:`).test(css) || id === 'steady', `${id}: has a tint in style.css`);
}
ok(Object.keys(thoughts).every((id) => ids.includes(id)), 'no bubble pool for an unknown mood');
ok(/import \{[^}]*\} from '\.\/thoughts\.js'/.test(app), 'app.js imports its bubble lines from thoughts.js');
for (const [pool, lines] of [...Object.entries(THOUGHTS), ...Object.entries(TROLL_THOUGHTS)]) ok(Array.isArray(lines) && lines.length >= 1 && lines.every((l) => typeof l === 'string' && l.length > 0 && l.length <= 60), `bubble pool ${pool}: 1+ lines of at most 60 characters`);
ok(/if \(t\.key === key\) return;/.test(app), 'the bubble shows only when the approach changes (not on a mood change alone)');
if (fails) { console.log(`check-moods-ui: ${fails} failure(s)`); process.exit(1); }
console.log(`check-moods-ui: ok (${ids.length} moods)`);
