# Hosted multiplayer operations

Run `npm run serve` with Node 20.12 or newer. The service binds to `127.0.0.1:3100` by default; `PORT`, `HOST`, and `DATA_DIR` override the listener and data folder. Set `JEV_API_KEY` for monster decisions. Keep `HOST` loopback unless remote hosting is deliberate; remote host access also requires `HOST_REMOTE=1`.

The default data folder is `runs/server/`. It contains the exclusive `server.lock`, the host token, append-only settings revisions, and one folder per game. Game folders contain metadata, captured rules, the dungeon, the current state, append-only events and call records, and periodic cold snapshots. Participant Jev keys exist only in worker memory. After a restart, every active game opens paused and each living participant must enter their key again.

## Backup and restore

Stop the service cleanly before copying the data folder. Preserve file permissions, especially the `host-token` file (mode `0600`). Store backups somewhere access-controlled: names, game state, event history, and call metadata are present even though keys and request bodies are not.

To restore, stop any service using the target folder, replace the complete data folder from the backup, then start the service with the same `DATA_DIR`. The store lock prevents two service processes from owning one folder. Recovery uses `state.json` as the committed point and drops event-log entries beyond its `event_seq`; it then pauses active games for key re-entry. A copied host token remains valid only if `HOST_TOKEN` is unset and the restored token file is used.

Call records keep HTTP status, byte counts, duration, actor, and outcome. They do not keep keys, prompts, or responses. A torn final JSONL line is ignored when reading logs. Keep the folder as one backup unit; copying only `state.json` or only `events.jsonl` breaks the recovery boundary.

## Health and host metrics

`GET /health` reports service uptime, loaded game and worker counts, and worker exits. The authenticated host Metrics tab reports Jev POST attempts and latency percentiles, failures and timeouts, the largest observed actor queue delay and event write duration, current SSE clients, and the largest observed blocked SSE write duration. These are process-local runtime counters except the call totals, which are read from each game's call log.

## Recovery checks

Run `node scripts/check-persistence.mjs` and `node scripts/check-service.mjs` for local, stubbed recovery and HTTP checks. They install a fetch tripwire and do not call Jev. Never use a paid run as a health check.
