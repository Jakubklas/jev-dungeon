# Hosted Jev calibration, 2026-10-14

The user authorized the paid measurement and merge. Ran the actual `GameActor` scheduler with one explorer and real Jev explorer/monster askers through the hosted gateway:

`node scripts/measure-runtime.mjs --live --decisions 60 --max-posts 120 --seconds 180 --seed 13 --out docs/measurements/multiplayer-latency-2026-10-14.json`

The run completed 60 paid explorer decisions in 23.7 seconds. Decision period is the explorer's observation-to-completion duration plus its 90 ms cadence; forced and held turns without an ask are excluded. Median period was **352.3 ms**, p90 **610.6 ms**. There were 118 HTTP posts: 9 sentiment, 60 explorer move, and 49 monster attempts. 116 returned HTTP 200; two monster requests still in flight were aborted when measurement stopped. No decision failed and no retry was needed.

Set the built-in `rules.stepMs` default to **350 ms**, the median rounded to the registry's 10 ms increment. Derived durations are grace 1.4 s, heart respawn 70 s, regen 10.5 s, sword cooldown 0.35 s, shield and stun 0.7 s, and fire cooldown 42 s. At monster speed 0.6, movement interval is about 583 ms. Existing games retain their captured rules revision.

New stores use the calibrated default. An existing store keeps its saved settings revision; its host can set `stepMs` to 350 for subsequent games. Post-calibration verification passed all 51 free checks, including unchanged request hashes.

This is a bounded calibration on one seed and connection, not a throughput benchmark or a guarantee of future latency. The raw JSON records timings and sanitized attempt metadata, with no key, request body or response body. The script supports free stub mode and a hard cap on all live HTTP posts, including retries.
