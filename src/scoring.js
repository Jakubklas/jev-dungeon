// Ranking for a finished shared game (PLAN-multiplayer "Combat and victory", Ranking). Pure: no I/O, no clock.
// Input per participant: { participant_id, name, slot, joined_at, coins, strikes, dispels, portal, alive, forfeited, died_at }.
// `strikes` counts every strike landed (a dispel is also a strike), so a dispel is worth strike + dispel points.
// Order: points, then more dispels, more coins, later death (survivors first), earlier join, then slot, then id.

export const DEFAULT_POINTS = Object.freeze({ coin: 10, strike: 3, dispel: 20, portal: 30, alive: 15 });

const num = (v) => (Number.isFinite(v) ? v : 0);

export function scoreParticipant(p, points = DEFAULT_POINTS) {
  const pts = { ...DEFAULT_POINTS, ...points };
  const forfeited = p.forfeited === true;
  const alive = p.alive === true && !forfeited;
  const breakdown = {
    coins: num(p.coins) * pts.coin,
    strikes: num(p.strikes) * pts.strike,
    dispels: num(p.dispels) * pts.dispel,
    portal: p.portal ? pts.portal : 0,
    alive: alive ? pts.alive : 0,
  };
  const total = breakdown.coins + breakdown.strikes + breakdown.dispels + breakdown.portal + breakdown.alive;
  return {
    participant_id: p.participant_id, name: p.name, slot: p.slot ?? null,
    coins: num(p.coins), strikes: num(p.strikes), dispels: num(p.dispels),
    portal: !!p.portal, alive, forfeited, points: total, breakdown,
    died_at: p.died_at ?? null, joined_at: num(p.joined_at),
  };
}

// Survivors first, then the later death.
function deathOrder(a, b) {
  if (a.alive !== b.alive) return a.alive ? -1 : 1;
  if (a.alive) return 0;
  return (b.died_at ?? -Infinity) - (a.died_at ?? -Infinity);
}

export function rankParticipants(participants, { points = DEFAULT_POINTS } = {}) {
  return participants.map((p) => scoreParticipant(p, points)).sort((a, b) =>
    b.points - a.points || b.dispels - a.dispels || b.coins - a.coins || deathOrder(a, b) ||
    a.joined_at - b.joined_at || (a.slot ?? 0) - (b.slot ?? 0) || String(a.participant_id).localeCompare(String(b.participant_id)));
}

export const teamScore = (rows) => rows.reduce((s, r) => s + r.points, 0);
