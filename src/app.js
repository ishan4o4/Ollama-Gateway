import express from 'express';
import helmet from 'helmet';
import cors from 'cors';
import { config } from './config.js';
import { ApiError } from './errors.js';
import { authenticate } from './middleware/auth.js';
import { authFailLimiter, ipLimiter, keyLimiter } from './middleware/rateLimit.js';
import { ollamaFetch } from './services/ollama.js';
import generationRouter from './routes/generation.js';
import modelsRouter from './routes/models.js';
import statusRouter from './routes/status.js';

function requestLogger(req, res, next) {
  const start = process.hrtime.bigint();
  res.on('finish', () => {
    const ms = Number(process.hrtime.bigint() - start) / 1e6;
    // never log bodies, headers or keys — only a short key fingerprint
    console.log(`${new Date().toISOString()} ${req.ip} ${req.auth?.id ?? '-'} ${req.method} ${req.originalUrl.split('?')[0]} ${res.statusCode} ${ms.toFixed(0)}ms`);
  });
  next();
}

export function createApp() {
  const app = express();
  app.disable('x-powered-by');
  if (config.trustProxy !== false) app.set('trust proxy', config.trustProxy);

  app.use(helmet());
  app.use(cors({
    origin: config.cors.origins.length ? config.cors.origins : false,
    methods: ['GET', 'POST'],
    allowedHeaders: ['Content-Type', 'Authorization', 'X-API-Key'],
    maxAge: 600,
  }));
  app.use(requestLogger);
  app.use(ipLimiter);

  // Unauthenticated, intentionally minimal
  app.get('/health', (req, res) => res.json({ status: 'ok' }));
  app.get('/ready', async (req, res) => {
    try {
      await ollamaFetch('/api/version', { method: 'GET', timeoutMs: 3000 });
      res.json({ status: 'ready' });
    } catch {
      res.status(503).json({ status: 'unavailable' });
    }
  });

  // Everything under /v1 requires an API key. Bodies are only parsed after auth succeeds.
  const v1 = express.Router();
  v1.use(authFailLimiter, authenticate, keyLimiter, express.json({ limit: `${config.bodyLimitKb}kb` }));
  v1.use(statusRouter);
  v1.use('/models', modelsRouter);
  v1.use(generationRouter);
  app.use('/v1', v1);

  app.use(() => { throw new ApiError(404, 'not_found', 'Route not found'); });

  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    if (res.headersSent) return res.destroy(); // mid-stream failure: just cut the connection
    let status = 500, code = 'internal_error', message = 'Internal server error';
    if (err instanceof ApiError) ({ status, code, message } = err);
    else if (err.type === 'entity.too.large') [status, code, message] = [413, 'payload_too_large', 'Request body too large'];
    else if (err.type === 'entity.parse.failed') [status, code, message] = [400, 'invalid_json', 'Malformed JSON body'];
    else if (err.name === 'TimeoutError') [status, code, message] = [504, 'upstream_timeout', 'Ollama did not respond in time'];
    else if (err.name === 'AbortError') [status, code, message] = [499, 'client_closed', 'Request aborted'];
    else console.error('[error]', err);
    res.status(status).json({ error: { code, message } });
  });

  return app;
}
