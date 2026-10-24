import { Router } from 'express';
import { config } from '../config.js';
import { slots } from '../middleware/concurrency.js';
import { ollamaJson } from '../services/ollama.js';
import { state as runtime } from '../runtime/ollamaRuntime.js';

const router = Router();

// GET /v1/status — gateway + Ollama health and the active resource caps
router.get('/status', async (req, res) => {
  let ollama;
  try {
    const v = await ollamaJson('/api/version', { method: 'GET', timeoutMs: 3000 });
    ollama = { reachable: true, version: v.version, mode: runtime.mode, restarts: runtime.restarts };
  } catch {
    ollama = { reachable: false, mode: runtime.mode, error: runtime.error };
  }
  res.json({
    status: ollama.reachable ? 'ok' : 'degraded',
    ollama,
    role: req.auth.role,
    default_model: config.models.default,
    auto_model: config.auto.enabled ? { selected: config.auto.state?.selected ?? null, at: config.auto.state?.at ?? null } : false,
    keep_alive: { mode: config.keepAlive.mode, value: config.keepAlive.value },
    limits: { ...config.limits },
    concurrency: slots.stats(),
    rate_limit: { windowMs: config.rateLimit.windowMs, max: config.rateLimit.max },
  });
});

export default router;
