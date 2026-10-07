// Tiny zero-dependency server: holds the one dungeon game and runs the world ticks.
// The API key stays here and never reaches the browser.
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';

// .env lives at the repo root, shared with the other projects. Load it before
// importing the turn module (it pulls in the brain and jev.js, which may read the key at load).
process.loadEnvFile(new URL('../.env', import.meta.url));
if (!process.env.JEV_API_KEY) throw new Error('JEV_API_KEY is missing from .env');
const { newGame, newTestGame } = await import('./src/turn.js');
const { TestbedError } = await import('./src/testbed.js');
const settings = await import('./src/settings.js');

const PORT = Number(process.env.PORT) || 3003;
// DATA_DIR (set by hub.js) moves everything this server writes (settings.json, memory.json/md,
// adversaries.json) into its own folder, so many servers can run side by side. Unset = next to server.js.
const DATA = process.env.DATA_DIR ? pathToFileURL(resolve(process.env.DATA_DIR) + '/') : null;
const GAME_OPTS = DATA ? { dir: DATA, memoryDir: DATA } : {};
// Per-server tunables (the /settings page); one file per port, so the normal and testbed servers differ.
await settings.loadSettings(DATA ? new URL('settings.json', DATA) : new URL(`settings-${PORT}.json`, import.meta.url));
// TESTBED=size=9x9&numAdversaries=2 (or a JSON object) makes this server a testbed: every new game
// without its own { testbed } body is that arena. Empty means a normal dungeon server.
const TESTBED = !process.env.TESTBED ? null
  : process.env.TESTBED.trim().startsWith('{') ? JSON.parse(process.env.TESTBED)
  : Object.fromEntries(new URLSearchParams(process.env.TESTBED));
if (TESTBED) newTestGame(TESTBED, GAME_OPTS); // fail at startup on a bad config, not on the first page load
const STATIC = {
  '/': ['index.html', 'text/html; charset=utf-8'],
  '/app.js': ['app.js', 'text/javascript; charset=utf-8'],
  '/settings': ['settings.html', 'text/html; charset=utf-8'],
  '/style.css': ['style.css', 'text/css; charset=utf-8'],
  '/sprites.js': ['sprites.js', 'text/javascript; charset=utf-8'],
  '/props/index.js': ['props/index.js', 'text/javascript; charset=utf-8'],
  '/props/floor-art.js': ['props/floor-art.js', 'text/javascript; charset=utf-8'],
  '/props/wall-art.js': ['props/wall-art.js', 'text/javascript; charset=utf-8'],
};

// One game for the whole playground.
let run = null;
// The step in flight, if any. Steps never run concurrently, and /api/new waits for
// an in-flight step so its memory save can't overwrite the fresh memory.
let busy = null;

const snapshot = () => ({ game: run ? run.view() : null, memory: run ? run.memory : null });

async function readBody(req) {
  let body = '';
  for await (const chunk of req) {
    body += chunk;
    if (body.length > 20_000) throw new Error('Request too large');
  }
  return body;
}

function send(res, status, body, type = 'application/json') {
  res.writeHead(status, { 'Content-Type': type });
  res.end(type === 'application/json' ? JSON.stringify(body) : body);
}

// `testbed`: a config for src/testbed.js (a small test arena), or null for a normal dungeon.
async function startNewGame(testbed = null) {
  while (busy) await busy.catch(() => {});
  settings.applyNextGame(); // saved settings that wait for a new game take effect here
  run = testbed ? newTestGame(testbed, GAME_OPTS) : newGame(undefined, GAME_OPTS);
  await run.persist(); // fresh memory.json/md and adversaries.json now, not at the first step
  const d = run.game.dungeon;
  console.log(`New ${testbed ? 'testbed arena' : 'dungeon'}, seed ${d.seed}, ${d.width}x${d.height}, ${run.game.adversaries?.length ?? 0} adversaries`);
  return snapshot();
}

async function step() {
  const p = run.playTurn();
  busy = p;
  try {
    const turn = await p;
    return { ...snapshot(), turn };
  } finally {
    busy = null;
  }
}

createServer(async (req, res) => {
  try {
    const path = new URL(req.url, 'http://localhost').pathname;

    if (req.method === 'GET' && STATIC[path]) {
      const [file, type] = STATIC[path];
      return send(res, 200, await readFile(new URL(`public/${file}`, import.meta.url)), type);
    }

    if (req.method === 'GET' && path === '/api/settings') return send(res, 200, settings.view());

    if (req.method === 'POST' && path === '/api/settings') {
      let body;
      try {
        body = JSON.parse((await readBody(req)) || '{}');
        return send(res, 200, await settings.saveSettings(body.values));
      } catch (err) {
        return send(res, 400, { error: err.message });
      }
    }

    if (req.method === 'GET' && path === '/api/state') {
      return send(res, 200, snapshot());
    }

    if (req.method === 'POST' && path === '/api/new') {
      // Optional body { testbed: {...} } (see AGENTS.md "Testbed"). Anything else starts a normal dungeon.
      let opts = {};
      try {
        opts = JSON.parse((await readBody(req)) || '{}') ?? {};
      } catch {
        return send(res, 400, { error: 'Body must be JSON.' });
      }
      try {
        return send(res, 200, await startNewGame(opts.testbed ?? TESTBED));
      } catch (err) {
        if (err instanceof TestbedError) return send(res, 400, { error: `Bad testbed config: ${err.message}` });
        throw err;
      }
    }

    if (req.method === 'POST' && path === '/api/step') {
      await readBody(req);
      if (!run) return send(res, 409, { error: 'No game. Call /api/new first.' });
      if (run.game.won || run.game.lost) return send(res, 409, { error: `The game is already ${run.game.won ? 'won' : 'lost'}.` });
      if (busy) return send(res, 409, { error: 'A step is already in progress.' });
      try {
        return send(res, 200, await step());
      } catch (err) {
        console.error('Turn failed:', err);
        return send(res, 502, { error: err.message });
      }
    }

    send(res, 404, 'Not found', 'text/plain');
  } catch (err) {
    console.error(err);
    send(res, 500, { error: 'Server error' });
  }
}).listen(PORT, process.env.HOST || undefined, () => console.log(`Jev Dungeon${TESTBED ? ' testbed' : ''} running at http://localhost:${PORT}`));
