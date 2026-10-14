// Per-viewer hosted projection. The raw Game.publicView includes the full map for local debugging;
// hosted players receive only shared lit cells and their own brain memory.
import { brainView, visibleAdversaries } from '../characters/adversary/adversary.js';

export function gameSummary({ id, mode, lobby, rulesRevision }, viewerId = null, now = Date.now()) {
  return { id, mode, status: lobby.status, pause_reason: lobby.pauseReason, capacity: lobby.capacity,
    leader: lobby.leader, rules_revision: rulesRevision, created_at: lobby.createdAt,
    participants: lobby.participants.map((p) => ({
      ...(p.participantId === viewerId ? { participant_id: p.participantId } : {}),
      name: p.name, slot: p.slot, state: p.state === 'waiting' ? 'ready' : p.state,
      key_present: p.keyPresent, is_leader: p.participantId === lobby.leader,
      is_self: p.participantId === viewerId,
      ...(p.state === 'awaiting_key' && p.keyDeadline !== null ? { key_deadline_ms_left: Math.max(0, p.keyDeadline - now) } : {}),
    })),
  };
}

export function projectGame({ game, brains, lobby, id, mode, rulesRevision, viewerId, reveal = false, ranking = null }) {
  const viewer = lobby.participant(viewerId);
  const self = viewer && game.explorers.find((e) => e.id === viewer.participantId);
  const base = game.publicView();
  const lit = (x, y) => reveal || (game.light[y]?.[x] ?? 0) > 0;
  const tiles = base.tiles.map((row, y) => [...row].map((tile, x) => lit(x, y) ? tile : null));
  const visible = new Set(self && self.status === 'active' ? visibleAdversaries(game, self.id).map((a) => a.id) : []);
  const team = new Set(game.activeExplorers().flatMap((e) => visibleAdversaries(game, e.id).map((a) => a.id)));
  const adversaries = game.adversaries.filter((a) => reveal || team.has(a.id)).map((a) => ({
    id: a.id, pos: [...a.pos], mode: a.mode, facing: a.facing, kind: a.kind, hp: a.hp, max_hp: a.maxHp,
    brain: (() => { const b = brainView(a); return { on: b.on, approach: b.approach, approach_since: b.approach_since, approach_text: b.approach_text }; })(),
    visible: reveal || visible.has(a.id), team_visible: !reveal && !visible.has(a.id),
  }));
  const explorers = lobby.participants.filter((p) => p.slot !== null).map((p) => {
    const e = game.explorer(p.participantId);
    return { id: e.id, participant_id: p.participantId, name: p.name, slot: p.slot,
      pos: [...e.pos], facing: e.facing, status: p.state, self: p.participantId === viewerId,
      thought: (() => { const m = brains.get(e.id)?.memory; return m?.approach ? { id: m.approach.id, since_step: m.approach.since_step, thought: m.approach.thought, mood: m.sentiment?.id } : null; })(),
      health: e.health, max_health: e.maxHealth, invulnerable: game.graceActive(e), coins: e.coins };
  });
  const spectator = !self || self.status === 'dead' || self.status === 'forfeited';
  const explorerIds = new Set(game.explorers.map((e) => e.id));
  const strikes = game.strikes.filter((s) => reveal || explorerIds.has(s.by) || team.has(s.by))
    .map((s) => ({ ...s, cells: s.cells.filter(([x, y]) => lit(x, y)).map((c) => [...c]) }))
    .filter((s) => s.cells.length);
  const out = {
    width: base.width, height: base.height, tiles, start: lit(...base.start) ? base.start : null,
    treasure: base.treasure && lit(...base.treasure) ? base.treasure : null,
    props: base.props.filter((p) => lit(p.x, p.y)), decor: base.decor.filter((d) => lit(d.x, d.y)),
    coin_piles: base.coin_piles.filter(([x, y]) => lit(x, y)), light: base.light,
    heart_cells: game.heartPiles.filter(([x, y]) => lit(x, y)).map((c) => [...c]),
    pos: self?.pos ?? base.pos, steps: self?.steps ?? base.steps, health: self?.health ?? 0,
    max_health: self?.maxHealth ?? base.max_health, coins: self?.coins ?? 0,
    facing: self?.facing ?? base.facing, won: game.won, lost: game.lost, won_by: game.winBy,
    over: game.won || game.lost, strikes, explored_pct: base.explored_pct,
    invulnerable: self ? game.graceActive(self) : false,
    block: self && game.blockActive(self) ? self.block : null,
    adversaries, explorers, route: null, self: viewerId, spectator,
    memory: spectator ? null : (brains.get(self.id)?.memory ?? null),
    directive: spectator ? null : (brains.get(self.id)?.directive ?? null),
    lobby: gameSummary({ id, mode, lobby, rulesRevision }, viewerId),
  };
  if (ranking) { out.ranking = ranking; out.result = lobby.result?.outcome ?? (game.won ? 'won' : 'lost'); }
  return out;
}
