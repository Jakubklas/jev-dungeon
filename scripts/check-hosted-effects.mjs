// Exercise real renderer timing and hosted bubble code with a minimal canvas/DOM. No server or Jev.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import * as thoughtText from '../public/thoughts.js';
import { installTripwire } from './lib/tripwire.mjs';
const uninstall = installTripwire();
try {
  let now = 0;
  const errors = [];
  const context = () => new Proxy({
    getImageData: (_x, _y, w, h) => ({ data: new Uint8ClampedArray(w * h * 4) }),
    createImageData: (w, h) => ({ data: new Uint8ClampedArray(w * h * 4) }),
  }, { get: (o, k) => k in o ? o[k] : () => {} });
  const canvas = () => ({ width: 1, height: 1, getContext: () => context(), clientWidth: 800, clientHeight: 600 });
  let source = readFileSync(new URL('../public/render.js', import.meta.url), 'utf8');
  source = source.replace(/export const ready = Promise.all\(\[[\s\S]*?\n\]\);/, 'const ready = Promise.resolve();')
    .replaceAll('export ', '').replace('  metrics: () =>', '  effects: () => ({ strikeFx, fireFx }), isExplorerStrike: explorerStrike,\n  metrics: () =>');
  const scope = vm.createContext({ document: { createElement: canvas }, window: { devicePixelRatio: 1 }, performance: { now: () => now }, console: { error: (...e) => errors.push(e), warn: (...e) => errors.push(e) } });
  vm.runInContext(source + '\nglobalThis.makeRenderer = createRenderer;', scope);
  const r = scope.makeRenderer(canvas(), { wrap: canvas() });
  const view = { width: 5, height: 5, tiles: Array(5).fill('.....'), light: Array.from({ length: 5 }, () => Array(5).fill(1)), pos: [2, 2], start: [2, 2], adversaries: [], explorers: [{ id: 'p1', self: true, pos: [2, 2], status: 'active' }], strikes: [] };
  r.setView(view, { reset: true });
  const strike = { id: 'p1:10:0', by: 'p1', from: [2, 2], cells: [[3, 2]], result: 'miss' };
  now = 10; r.setView({ ...view, strikes: [strike] });
  assert.equal(r.effects().strikeFx.t0, 10);
  now = 300; r.setView({ ...view, strikes: [strike] });
  assert.equal(r.effects().strikeFx.t0, 10, 'repeated SSE/poll view restarted a sword');
  now = 1000; r.frame(now);
  assert.equal(r.effects().strikeFx, null, 'attack cells did not expire');
  r.setView({ ...view, strikes: [strike] });
  assert.equal(r.effects().strikeFx, null, 'expired sword replayed');
  now = 1100;
  const fire = { ...strike, id: 'p1:1100:0', skill: 'fire_strike', centre: [3, 2] };
  r.setView({ ...view, strikes: [fire] });
  now = 1300; r.setView({ ...view, strikes: [fire] });
  assert.equal(r.effects().fireFx.t0, 1100, 'repeated view restarted fire');
  now = 3000; r.frame(now);
  assert.equal(r.effects().fireFx, null, 'fire did not expire');
  assert.equal(errors.length, 0, JSON.stringify(errors));
  assert.equal(r.isExplorerStrike(strike), true, 'multiplayer knight got claw art');
  assert.equal(r.isExplorerStrike({ by: 'a1' }), false);
  console.log('hosted effects: repeated views, sword/fire expiry and multiplayer slash identity: ok');
} finally { uninstall(); }
