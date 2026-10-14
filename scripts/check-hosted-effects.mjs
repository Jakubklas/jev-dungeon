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
  const node = () => ({
    offsetWidth: 120, offsetHeight: 40, dataset: {}, children: [],
    style: { setProperty(k, v) { this[k] = v; } },
    append(...kids) { this.children.push(...kids); },
    replaceChildren(...kids) { this.children = kids; }, remove() { this.removed = true; },
  });
  const layer = node();
  const play = readFileSync(new URL('../public/play.js', import.meta.url), 'utf8');
  const bubbleCode = play.slice(play.indexOf('const bubbles = new Map();'), play.indexOf('function myExplorer()'));
  const bubbleView = {
    explorers: [
      { id: 'p1', self: true, thought: { id: 'engage', since_step: 1, mood: 'bold' } },
      { id: 'p2', self: false, thought: { id: 'collect_coins', since_step: 2, mood: 'greedy' } },
    ],
    adversaries: [
      { id: 'a1', visible: true, kind: 'tree_giant', brain: { on: true, approach: 'direct_pursuit', approach_since: 1 } },
      { id: 'hidden', visible: false, brain: { on: true, approach: 'direct_pursuit', approach_since: 1 } },
    ],
  };
  const heads = new Map([['@', { x: 100, y: 100, alpha: 1 }], ['e:p2', { x: 200, y: 100, alpha: 1 }], ['a1', { x: 300, y: 100, alpha: 1 }]]);
  const bubblesScope = vm.createContext({
    view: bubbleView, thoughtsMod: thoughtText, performance: { now: () => now },
    el: node, $: () => layer, renderer: { heads, metrics: () => ({ S: 2, dpr: 1, viewW: 800 }) },
  });
  vm.runInContext(bubbleCode + '\nglobalThis.testBubbles = { updateThoughts, drawThoughts, bubbles };', bubblesScope);
  const bt = bubblesScope.testBubbles;
  bt.updateThoughts();
  assert.equal(bt.bubbles.size, 3, 'expected both knights and the visible tree giant');
  assert.equal(bt.bubbles.has('hidden'), false, 'hidden enemy got a thought bubble');
  const began = bt.bubbles.get('@').t0;
  now += 500; bt.updateThoughts(); bt.drawThoughts(now);
  assert.equal(bt.bubbles.get('@').t0, began, 'unchanged approach restarted a bubble');
  assert.equal(bt.bubbles.get('@').node.style.opacity, '1');
  const before = bt.bubbles.get('e:p2').node.style.transform;
  heads.get('e:p2').x += 30; bt.drawThoughts(now);
  assert.notEqual(bt.bubbles.get('e:p2').node.style.transform, before, 'teammate bubble did not track its knight');
  bubbleView.explorers[1].thought.remark = 'That is a strong opponent.';
  bt.updateThoughts();
  assert.equal(bt.bubbles.get('e:p2').node.children[0], 'That is a strong opponent.', 'a knight remark was not shown overhead');
  const remarkAt = bt.bubbles.get('e:p2').t0;
  now += 100; bt.updateThoughts();
  assert.equal(bt.bubbles.get('e:p2').t0, remarkAt, 'a repeated remark restarted its bubble');
  now += 10000; bt.drawThoughts(now);
  assert.equal(bt.bubbles.get('@').node.style.opacity, '0', 'thought bubble never faded');
  bubbleView.adversaries[0].visible = false; bt.updateThoughts();
  assert.equal(bt.bubbles.has('a1'), false, 'enemy bubble remained after it left sight');
  console.log('hosted effects: repeated views, sword/fire expiry and multiplayer slash identity, overhead thoughts and fog: ok');
} finally { uninstall(); }
