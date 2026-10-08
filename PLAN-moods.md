# PLAN-moods: three confidence tiers, eight moods, panic

**Decision.** Confidence C (0..100) is split into three tiers. Each tier has its own moods, written in the same style as today's four, toned down for low C and toned up for high C. Below C 20 the explorer is in `panic`. C drifts 0.5 per tick toward 50 from either side, so no mood lasts the whole game.

Status: proposal approved by the owner in chat; revised after the implementation-spec review (section 6); no code yet. Code wins over this plan (AGENTS.md rule 3). Builds on PLAN-confidence-mood.md (`confidenceCaps`).

## 1. Tiers and moods

| Tier (C) | Mood | min_gap | end_ticks | Goes after | Fight rule |
| --- | --- | --- | --- | --- | --- |
| Low (<= 35) | `panic` (code-entered below 20, exit at 25; no sentiment call) | ignored | 8 | Get away at any cost. Lives, coins and enemies do not matter; only the clear path does. Attacks only an enemy that blocks the way. | Blocking enemy only |
| | `wary` | 4 | 5 | Run and hide; the portal if leaving is already worth it. | Never |
| | `guarded` | 3 | 4 | Explore away from known enemies, skip loot. | Never |
| Mid (36..69) | `cautious` | 4 | 4 | Keep distance, slip past, explore with a cushion. | A hurt monster, or when cornered |
| | `steady` | 3 | 4 | Follow the plan, coins on the way. | Single or hurt monster |
| | `greedy` | 3 | 2 | Coins and unexplored rooms; detours only with no enemy in sight. | Single or hurt monster if on the way |
| High (>= 70) | `bold` | 2 | 1 | Take the fight and press on. | Engages regardless of group size (no area skills exist yet) |
| | `fearless` | 1 | 1 | Hunt enemies down; dispelling is the goal. | Anything, outnumbered included |

Eight moods in total: 3 Low (`panic` included), 3 Mid, 2 High (`plunder` was dropped).

Rules:
- Low: `bold`, `greedy`, `fearless` are never selectable. High: `panic`, `wary`, `guarded`, `cautious` are never selectable. Mid: the three mid moods only. A tier change swaps the mood silently (as `confidenceCaps` does now), with hysteresis at the tier edges.
- `panic` is entered by code, not chosen by Jev. Its tactic list is `run_away` only; `engage` is offered only for an enemy that blocks the only known route. Its text never mentions lives; the last-life cap does not touch it.
- All prompt and UI text says "enemy" or "monster", never "ghost" (there will be more kinds). Code ids (`Adversary`, `adversaries.json`) stay, so request-hash fixtures only change where text changes.

## 2. Fight vocabulary

Prompts and code use three situations only: **single monster**, **hurt monster**, **outnumbered**. No counts like "2-3 ghosts" or "at most 2 strikes" in mood text. "Has a chance" is one judgment from `capability()` (lives, live skill numbers, skills ready). Future area attacks raise capability, so outnumbered fights open without rewriting moods. Today `bold` engages regardless of group size.

## 3. Regen

C moves **0.25 per tick** toward 50, from above and below, but only once **10 ticks have passed since C last changed** (any event delta, including a cap clamp, restarts the 10-tick wait). This replaces the old calm drift (+0.3, only below 50, only when alone). The wait is what makes the Low and High tiers reachable: a fresh hit or dispel is not undone at once. Examples after the wait: 15 to 25 (panic exit) takes 40 ticks, 15 to 50 takes 140; 95 to 50 takes 180. The wait counter is part of the confidence state (plain JSON, deterministic). `measure-caps.mjs` must confirm that Low, High and panic are reachable before the tier edges are final.

## 4. Thought bubbles

At least 3 per mood, first person, <= 60 characters, one picked at random each time the mood is chosen. Reuse the variants mechanism from commit d722edb.

| Mood | Bubbles |
| --- | --- |
| `panic` | "Out! Out! Out!" / "Just get away from here!" / "Nothing matters but the way out!" |
| `wary` | "Something's wrong. Keep my distance." / "I don't like this. Back off." / "Find cover first, think later." |
| `guarded` | "Stay sharp, keep moving." / "Eyes open, away from trouble." / "No detours. Careful progress." |
| `cautious` | "Slow down, check the corners." / "Stay clear and slip past." / "Fight only if I'm cornered." |
| `steady` | "Stick to the plan." / "One room at a time." / "If one shows up, I can handle it." |
| `greedy` | "I smell coins nearby." / "Worth a detour." / "Let's see what else is in here." |
| `bold` | "Come at me." / "I can take this one." / "Press on, no backing down." |
| `fearless` | "Bring them all." / "I'm cutting through." / "Nothing here stops me." |

## 5. Work

1. `confidence.js`: symmetric 0.5 regen, tier function, panic enter (< 20) / exit (>= 25), tests in `check-confidence.mjs`.
2. `brain.js` / `memory.js`: `SENTIMENTS` per tier, `MOOD_IDS` (8), `allowedMoods` by tier, panic path (`run_away` only), silent swap, enemy wording, bubbles.
3. UI: mood display for the new ids.
4. Fixtures: regenerate `request-hashes-caps.json` on purpose, in its own commit; `check-dungeon` request-size bounds re-checked (fewer options per sentiment call, so smaller).
5. Docs: AGENTS.md and CONTRACT.md updated with the code.

Everything stays behind `confidenceCaps` (off by default), so requests with it off stay byte-identical. A paid live run needs the owner's approval.

## 6. Decisions after the implementation-spec review

- **Caps only.** `confidenceCaps` stops being a toggle: it is the only confidence model. Remove the legacy four-mood `SENTIMENTS` table (the 8 moods are the only table), `confidenceModel`, `confidenceMeter`, the C2/C3 gap and engage gates, the old `calm` event and the caps-off request-hash baseline. Request-hash fixtures are regenerated once, in their own commit; "caps off is byte-identical" no longer applies. The `hold` option stays (`'multi'` is the default).
- **Enemy wording** applies to all text sent to Jev (`rules()`, move facts, triggers), not only caps strings.
- **No numbers about enemies.** Remove the numeric fight gates (`#fightOn` speed and hp guards, "at most 2 strikes", counts of enemies). Jev gets the facts (hp bars, the sword's numbers) and decides; moods differ only in stance, per section 1.
- **No-sword fallback.** No special tier list: the tier follows C, and `NO_SWORD_MAX = 20` already caps capability.
- **panic** ends only when C >= 25 (not on `chase_over`). The whisper-bar directive cannot override it (a directive is held, not applied, while panic lasts). It may use `race_to_exit` when the portal is known (the portal is a clear path), with `min_gap` 1 for feasibility and targets; `engage` only for an enemy that blocks the only known route.
- **Mood bubbles** show only when the approach changes.
- **Commit order:** 1 regen + tiers; 2 caps-only cleanup (delete legacy paths); 3 moods table and wording; 4 panic; 5 bubbles and UI; 6 fixtures alone; 7 docs.
