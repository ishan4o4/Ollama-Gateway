import { Router } from 'express';
import { config } from '../config.js';
import { ApiError } from '../errors.js';
import { requireAdmin } from '../middleware/auth.js';
import { acquireSlot } from '../middleware/concurrency.js';
import { abortOnClose, ollamaFetch, ollamaJson } from '../services/ollama.js';
import { keepAliveFor, loadModel, normName, resolveModel, unloadModel } from '../services/models.js';
import { normalizeKeepAlive } from '../keepAlive.js';
import { bad, optionalBool, requireString } from '../validate.js';
import { selectBestModel } from '../services/auto.js';

const router = Router();
const admin = { enforceChoice: false };

// GET /v1/models — allowed models, whether installed, whether loaded right now
router.get('/', async (req, res) => {
  const [tags, ps] = await Promise.allSettled([
    ollamaJson('/api/tags', { method: 'GET', timeoutMs: 5000 }),
    ollamaJson('/api/ps', { method: 'GET', timeoutMs: 5000 }),
  ]);
  const installed = tags.status === 'fulfilled' ? new Set(tags.value.models.map((m) => normName(m.name))) : null;
  const running = ps.status === 'fulfilled' ? new Map(ps.value.models.map((m) => [normName(m.name), m])) : null;

  res.json({
    default: config.models.default,
    client_model_choice: config.models.allowClientChoice,
    models: [...config.models.registry.values()].map((m) => {
      const live = running?.get(normName(m.name));
      return {
        name: m.name,
        description: m.description,
        capabilities: m.capabilities,
        keep_alive: keepAliveFor(m),
        installed: installed ? installed.has(normName(m.name)) : null,
        loaded: running ? Boolean(live) : null,
        expires_at: live?.expires_at ?? null,
      };
    }),
  });
});

// GET /v1/models/running — what Ollama currently holds in memory
router.get('/running', async (req, res) => {
  const ps = await ollamaJson('/api/ps', { method: 'GET', timeoutMs: 5000 });
  res.json({
    models: ps.models.map(({ name, size, size_vram, expires_at }) => ({ name, size, size_vram, expires_at })),
  });
});

// GET /v1/models/auto — last automatic selection and why other models were skipped
router.get('/auto', (req, res) => {
  res.json({ enabled: config.auto.enabled, current_default: config.models.default, last_run: config.auto.state });
});

// POST /v1/models/auto (admin) — re-run selection now (e.g. after resizing the VM)
router.post('/auto', requireAdmin, async (req, res) => {
  res.json(await selectBestModel());
});

// POST /v1/models/load (admin) { model?, permanent?: bool, keep_alive?: "-1"|"10m"|seconds }
router.post('/load', requireAdmin, async (req, res) => {
  const b = req.body ?? {};
  const model = resolveModel(b.model, undefined, admin);
  const permanent = optionalBool(b.permanent, 'permanent', undefined);
  let keepAlive = keepAliveFor(model);
  if (b.keep_alive !== undefined) {
    try { keepAlive = normalizeKeepAlive(b.keep_alive); } catch (e) { throw bad(e.message); }
  } else if (permanent !== undefined) {
    keepAlive = permanent ? -1 : config.keepAlive.timed;
  }
  await acquireSlot(req, res);
  await loadModel(model, keepAlive, abortOnClose(res));
  res.json({ model: model.name, loaded: true, keep_alive: keepAlive });
});

// POST /v1/models/unload (admin) { model? }
router.post('/unload', requireAdmin, async (req, res) => {
  const model = resolveModel((req.body ?? {}).model, undefined, admin);
  await acquireSlot(req, res);
  await unloadModel(model, abortOnClose(res));
  res.json({ model: model.name, loaded: false });
});

// POST /v1/models/pull (admin) { model } — only models listed in models.json
router.post('/pull', requireAdmin, async (req, res) => {
  const name = requireString((req.body ?? {}).model, 'model', 200);
  const model = resolveModel(name, undefined, admin);
  const upstream = await ollamaFetch('/api/pull', {
    body: { model: model.name, stream: false },
    timeoutMs: config.ollama.pullTimeoutMs,
    signal: abortOnClose(res),
  });
  const result = await upstream.json();
  if (result.error) throw new ApiError(502, 'upstream_error', result.error);
  res.json({ model: model.name, status: result.status ?? 'success' });
});

export default router;
