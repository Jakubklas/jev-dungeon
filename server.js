// Tiny zero-dependency server: holds the one dungeon game and runs the world ticks.
// The API key stays here and never reaches the browser.
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';

// .env lives at the repo root, shared with the other projects. Load it before
// importing the turn module (it pulls in the brain and jev.js, which may read the key at load).
process.loadEnvFile(new URL('../.env', import.meta.url));
if (!process.env.JEV_API_KEY) throw new Error('JEV_API_KEY is missing from .env');
const { newGame, newTestGame, playTurn, view } = await import('./src/turn.js');
const { TestbedError } = await import('./src/testbed.js');

const PORT = Number(process.env.PORT) || 3003;
// TESTBED=size=9x9&numAdversaries=2 (or a JSON object) makes this server a testbed: every new game
// without its own { testbed } body is that arena. Empty means a normal dungeon server.
const TESTBED = !process.env.TESTBED ? null
  : process.env.TESTBED.trim().startsWith('{') ? JSON.parse(process.env.TESTBED)
  : Object.fromEntries(new URLSearchParams(process.env.TESTBED));
if (TESTBED) newTestGame(TESTBED); // fail at startup on a bad config, not on the first page load
const STATIC = {
  '/': ['index.html', 'text/html; charset=utf-8'],
  '/app.js': ['app.js', 'text/javascript; charset=utf-8'],
  '/style.css': ['style.css', 'text/css; charset=utf-8'],
  '/sprites.js': ['sprites.js', 'text/javascript; charset=utf-8'],
  '/props/index.js': ['props/index.js', 'text/javascript; charset=utf-8'],
  '/props/floor-art.js': ['props/floor-art.js', 'text/javascript; charset=utf-8'],
  '/props/wall-art.js': ['props/wall-art.js', 'text/javascript; charset=utf-8'],
};

// One game for the whole playground.
let game = null;
let memory = null;
// The step in flight, if any. Steps never run concurrently, and /api/new waits for
// an in-flight step so its memory save can't overwrite the fresh memory.
let busy = null;

const snapshot = () => ({ game: game ? view(game) : null, memory });

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
  ({ game, memory } = testbed ? newTestGame(testbed) : newGame());
  const d = game.dungeon;
  console.log(`New ${testbed ? 'testbed arena' : 'dungeon'}, seed ${d.seed}, ${d.width}x${d.height}, ${game.adversaries?.length ?? 0} adversaries`);
  return snapshot();
}

async function step() {
  const run = playTurn(game, memory);
  busy = run;
  try {
    const turn = await run;
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
      if (!game) return send(res, 409, { error: 'No game. Call /api/new first.' });
      if (game.won || game.lost) return send(res, 409, { error: `The game is already ${game.won ? 'won' : 'lost'}.` });
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
}).listen(PORT, () => console.log(`Jev Dungeon${TESTBED ? ' testbed' : ''} running at http://localhost:${PORT}`));
