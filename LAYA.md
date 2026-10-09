# Local Laya

The game can use [Laya's official HTTP server](https://github.com/NandhaKishorM/laya), which implements the same `/v1/systemone` choice, score and yes/no protocol as Jev. Local inference runs on this machine and does not call the paid TypeSafe API.

```sh
python3 scripts/laya-local.py setup
python3 scripts/laya-local.py start
python3 scripts/laya-local.py status
python3 scripts/laya-local.py stop
```

Setup installs the pinned `laya[serve]==0.4.1` package into `runs/laya/venv`. Start binds only `127.0.0.1:8000`, preloads the multilingual `multilingual` checkpoint from the `convaiinnovations/laya` repository’s `multilingual/` subfolder, and keeps one checkpoint resident. The first start downloads model weights from Hugging Face; wait for `/health` to report ready before playing. PyTorch chooses Apple MPS when available, otherwise CPU. Python 3.10 or newer is required.

The environment, Hugging Face cache, PID and logs stay in the ignored `runs/laya/` directory. Read `runs/laya/server.log` if startup or a request fails. `LAYA_THREADS` can override the default of four CPU threads. The process continues after the launcher exits; use the stop command to release its memory.

Select it in `central-config.yaml`:

```yaml
decision:
  provider: laya
  laya:
    endpoint: http://127.0.0.1:8000/v1/systemone
    model: multilingual
    maxLen: 8192
    headMaxLen: 1024
    timeoutMs: 120000
```

Set `decision.provider: jev` to return to the paid Jev service. Laya requests have no bearer credential, use a single request, and never fall back to Jev when the local server is unavailable. Model quality differs from Jev. The multilingual checkpoint is selected for its longer context; the game sends `max_len: 8192` and `head_max_len: 1024` so full game states and question instructions fit instead of using the checkpoint’s shorter default. The launcher uses the checkpoint revision reviewed by the pinned Laya package.
