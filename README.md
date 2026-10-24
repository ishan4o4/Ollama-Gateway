# ollama-gateway

A secure, resource-capped REST gateway in front of an [Ollama](https://ollama.com) server. Node.js ≥ 20, Express 5.

## Quick start (only Node.js ≥ 20 needed on the server)

```bash
unzip ollama-gateway.zip && cd ollama-gateway
node src/server.js
```

That's it. Dependencies are already bundled in `node_modules/`. On the **first start** the gateway:

1. creates `.env` and generates your API key + admin key (printed once, saved in `.env`),
2. downloads its own copy of Ollama into `data/ollama/` (checksum-verified; one time, ~1.5 GB) unless an Ollama is already running or installed,
3. starts and supervises Ollama (auto-restart on crash, stopped when the gateway stops),
4. downloads the default model into `data/models/`.

Nothing is installed system-wide and no root is needed. Delete the `data/` folder to remove everything. Keep it running with `pm2 start src/server.js --name ollama-gateway` or a systemd unit if you like.

| Env | Effect |
|---|---|
| `MANAGE_OLLAMA=false` | never start Ollama, only talk to `OLLAMA_URL` |
| `OLLAMA_AUTO_DOWNLOAD=false` | never download; use `OLLAMA_BIN` or an installed `ollama` |
| `OLLAMA_VERSION` | `latest` or a pinned tag such as `v0.40.10` |
| `CPU_ONLY=true` (default) | CPU only: GPU hidden from Ollama, GPU libraries deleted after download (saves several GB of disk), `num_gpu=0`. Set `false` to use a GPU |
| `OLLAMA_FLAVOR=rocm` | with `CPU_ONLY=false`: also fetch AMD GPU libraries |
| `DATA_DIR` | where the Ollama binary and models are stored |
| `PULL_DEFAULT_MODEL=false` | don't auto-download the default model |
| `OLLAMA_LOGS=true` | show Ollama's own log output |

Requirements for the one-time download: outbound HTTPS to `github.com` (Ollama) and `registry.ollama.ai` (models), ~2 GB free disk plus model size, and on Windows the built-in `tar.exe` (Windows 10+). On Node < 22.15 the Zstandard archive is unpacked with a bundled pure-JS decoder, which just takes a bit longer.

## Where things are configured

| What | Where |
|---|---|
| API keys, rate limits, resource caps, keep-alive mode | `.env` |
| Allowed models, default model, per-model options, per-model keep-alive, preload | `config/models.json` |

### Choosing the model
`config/models.json` is an allowlist. `defaultModel` is used when a request has no `model`. `DEFAULT_MODEL` in `.env` overrides it. Set `ALLOW_CLIENT_MODEL_CHOICE=false` to force everyone onto the default. Models not in the file are rejected (404), so clients can't make the server load arbitrary models.

### Automatic model selection
Set `AUTO_MODEL=true` and the gateway picks the model itself at startup:

1. Reads usable RAM (container/cgroup-aware, minus `AUTO_RESERVE_GB`; override with `AUTO_RAM_GB`).
2. Goes through models in `models.json` that have `memoryGb`, `paramsB` and `quality`, best `quality` first.
3. Skips a model if it won't fit in RAM, is estimated too slow (CPU-only, `MAX_NUM_GPU=0`), or isn't installed (`AUTO_PULL=true` downloads it).
4. Loads it with your keep-alive mode, runs a short benchmark, and rejects it if it measures below `AUTO_MIN_TPS` tokens/sec. Then the next model is tried.
5. The winner becomes the default. Requests with no `model`, or `"model": "auto"`, use it. Other loaded models are unloaded.

`GET /v1/models/auto` shows what was chosen and why others were skipped. `POST /v1/models/auto` (admin) re-runs selection, e.g. after resizing the VM. Requests that arrive during startup use `defaultModel` until selection finishes.

### Loading permanently or not
`KEEP_ALIVE_MODE` in `.env`:

| Mode | Behaviour |
|---|---|
| `permanent` | `keep_alive=-1`, model stays in memory until unloaded |
| `timed` | unloaded after `KEEP_ALIVE_DURATION` idle (e.g. `5m`) |
| `unload` | unloaded right after each request |

A model's own `"keepAlive"` in `models.json` overrides the global mode. `PRELOAD_ON_START=true` loads models flagged `"preload": true` (or the default model) at boot. Admins can change it at runtime with `/v1/models/load` and `/v1/models/unload`. Clients can't set `keep_alive` on generation requests.

### Resource caps
Enforced by the gateway on every request:

| Env | Effect |
|---|---|
| `MAX_CONCURRENT` / `MAX_QUEUE` / `QUEUE_TIMEOUT_MS` | simultaneous inferences, bounded wait queue, then 429/503 |
| `MAX_NUM_CTX` | context window ceiling (main RAM/VRAM driver) |
| `MAX_NUM_PREDICT` | max generated tokens (client values are clamped) |
| `MAX_NUM_THREAD` | CPU threads (default: half the cores) |
| `MAX_NUM_GPU` | GPU layers (`0` = CPU only) |
| `MAX_NUM_BATCH` | batch size |
| `MAX_PROMPT_CHARS`, `MAX_MESSAGES`, `MAX_BODY_KB` | input size |
| `REQUEST_TIMEOUT_MS` | hard time limit per request |

Clients can only set sampling options (`temperature`, `top_p`, `top_k`, `repeat_penalty`, `seed`, `num_predict`, `stop`). `num_ctx`, `num_thread`, `num_gpu` are server-controlled and identical for every request, so Ollama never reloads a model because options changed.

The gateway can't limit Ollama's own memory beyond what it sets for the Ollama it starts. For a hard cap, run it under a cgroup, e.g. `npm run ollama` (sets `OLLAMA_NUM_PARALLEL`, `OLLAMA_MAX_LOADED_MODELS`, `OLLAMA_MAX_QUEUE`) and, on Linux, a hard cgroup cap:

```bash
systemd-run --user --scope -p MemoryMax=8G -p CPUQuota=400% npm run ollama
```

## Security
- API keys only in `.env` (min 24 chars). Server refuses to start without keys unless `AUTH_DISABLED=true`.
- `X-API-Key: <key>` or `Authorization: Bearer <key>`. Keys are SHA-256 hashed in memory and compared in constant time.
- Two roles: `API_KEYS` (inference + read) and `ADMIN_API_KEYS` (also load/unload/pull).
- Rate limits: per IP, per API key, and a strict limiter on failed auth (brute-force protection).
- `helmet` headers, CORS off unless `CORS_ORIGINS` is set, body size limit, strict input validation, bodies parsed only after auth, generic 500 errors, no keys/bodies in logs.
- Binds to `127.0.0.1` by default. For remote access put it behind a TLS reverse proxy and set `TRUST_PROXY=1`. Don't expose Ollama's port itself.

## Endpoints

Errors are always `{"error": {"code": "...", "message": "..."}}`.

| Method | Path | Auth | Description |
|---|---|---|---|
| GET | `/health` | none | liveness |
| GET | `/ready` | none | Ollama reachable? |
| GET | `/v1/status` | user | versions, active caps, queue state |
| GET | `/v1/models` | user | allowed models, installed/loaded state |
| GET | `/v1/models/running` | user | models currently in memory |
| GET | `/v1/models/auto` | user | last automatic selection + reasons |
| POST | `/v1/models/auto` | admin | re-run automatic selection |
| POST | `/v1/models/load` | admin | `{model, permanent?, keep_alive?}` |
| POST | `/v1/models/unload` | admin | `{model}` |
| POST | `/v1/models/pull` | admin | `{model}` (allowlisted models only) |
| POST | `/v1/generate` | user | `{model?, prompt, system?, stream?, format?, options?}` |
| POST | `/v1/chat` | user | `{model?, messages[], stream?, format?, options?}` |
| POST | `/v1/embeddings` | user | `{model?, input: string \| string[]}` |

`stream: true` returns NDJSON (`application/x-ndjson`). Closing the connection cancels generation and frees the slot.

```bash
curl -H "X-API-Key: $KEY" -H 'content-type: application/json' \
  -d '{"messages":[{"role":"user","content":"Hello"}],"options":{"temperature":0.3}}' \
  http://127.0.0.1:3000/v1/chat

curl -H "X-API-Key: $ADMIN" -H 'content-type: application/json' \
  -d '{"model":"llama3.2:3b","permanent":true}' http://127.0.0.1:3000/v1/models/load
```

## Layout
```
config/models.json        model allowlist + per-model settings
src/config.js             env parsing and validation
src/app.js, server.js     wiring, error handling, startup/preload
src/middleware/           auth, rate limits, concurrency queue
src/routes/               status, models, generation
src/services/             ollama client, option clamping, model loading
src/runtime/              built-in Ollama download + supervisor, zstd fallback
src/bootstrap.js          first-run .env + key generation
scripts/start-ollama.js   optional: run Ollama alone with the same caps
```
