// World rules for skills: what a strike does to whoever stands in its cells. It reads and mutates a
// Game, so it is called only from world code (KnownWorld.useSkill, stepAdversaries), never from options().
// Ghost hp and stun live on Adversary (takeHit, numbers from skillConfig()).
// Events have the adversary-event shape { id, type, at, ... } so stepAdversaries can merge them.
import { isFloor } from '../dungeon.js';
import { skillConfig } from './config.js';

export const EXPLORER = Object.freeze({ id: 'explorer' }); // the attacker handle for the explorer's strikes

const same = (a, b) => a[0] === b[0] && a[1] === b[1];

// Applies one attack. cells: any cells (off-map and wall cells are dropped). canHit() gates damage on
// the explorer (grace, one hit per tick); onHit() runs after damage lands so the caller can latch it.
// Returns the events; the strike is also recorded in game.strikes as { by, cells, result }.
export function resolveAttack(game, attacker, cells, damage, { canHit = () => true, onHit = () => {}, rand } = {}) {
  const events = [];
  const live = cells.filter((c) => isFloor(game.dungeon, c));
  let result = 'miss';
  const fromExplorer = attacker.id === EXPLORER.id;

  if (!fromExplorer && live.some((c) => same(c, game.pos)) && !game.lost && !game.won) {
    const at = [...game.pos];
    if (game.block && game.steps <= game.block.until_step && (rand ?? (() => game.skillRandom()))() < game.block.effectiveness) {
      result = 'blocked';
      events.push({ id: attacker.id, type: 'blocked', at });
    } else if (!canHit()) {
      result = 'protected';
    } else {
      result = 'hit';
      const { health, lost } = game.damage(damage, attacker.id);
      onHit();
      events.push({ id: attacker.id, type: 'hit', at, health });
      if (lost) events.push({ id: attacker.id, type: 'caught', at });
    }
  }

  if (fromExplorer) {
    for (const a of [...game.adversaries]) {
      if (!live.some((c) => same(c, a.pos))) continue;
      const out = a.takeHit(damage, [...game.pos], game); // Adversary owns its hp, stun and knockback
      const at = [...a.pos];
      result = 'hit';
      if (out.dispelled) {
        game.adversaries.splice(game.adversaries.indexOf(a), 1); // in place: other holders of the array see it
        result = 'dispelled';
        // The tick's dispels, for the death cry: surviving monsters within sight or earshot lose morale (stepAdversaries).
        game.dispelled = [...(game.dispelled ?? []), { id: a.id, at: [...at] }];
        events.push({ id: a.id, type: 'dispelled', at });
        // One roll per dispel, even at chance 0 or 1, so the stream stays stable.
        if (game.coinRandom() < skillConfig().coinDropChance) {
          game.coinPiles = [...game.coinPiles, at];
          events.push({ id: a.id, type: 'coin_drop', at });
        }
        // Dispelling the last adversary wins the game. Only a dispel can do it: an arena that starts with
        // none (numAdversaries 0) is not won on tick 0.
        if (!game.adversaries.length && !game.won && !game.lost) {
          game.won = true;
          game.winBy = 'cleared';
          events.push({ id: 'explorer', type: 'cleared', at });
        }
      } else {
        events.push({ id: a.id, type: 'struck', at, hp: out.hp, staggered: out.staggered });
      }
    }
  }

  // `from` is where the attacker stood when it struck (the explorer often steps on before the view is drawn): the UI aims the slash from it.
  const from = [...(fromExplorer ? game.pos : attacker.pos)];
  game.strikes.push({ by: attacker.id, from, cells: live.map((c) => [...c]), result });
  events.push({ id: attacker.id, type: 'strike', cells: live.map((c) => [...c]), result });
  return events;
}
