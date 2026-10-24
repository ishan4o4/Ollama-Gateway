import rateLimit from 'express-rate-limit';
import { config } from '../config.js';

const tooMany = (message) => (req, res) =>
  res.status(429).json({ error: { code: 'rate_limited', message } });

const base = { standardHeaders: 'draft-7', legacyHeaders: false };

/** Broad per-IP guard for every route. */
export const ipLimiter = rateLimit({
  ...base,
  windowMs: config.rateLimit.windowMs,
  limit: config.rateLimit.ipMax,
  handler: tooMany('Too many requests from this IP'),
});

/** Only counts 401s, so brute-forcing keys gets an IP blocked quickly. */
export const authFailLimiter = rateLimit({
  ...base,
  windowMs: 15 * 60_000,
  limit: config.rateLimit.authFailMax,
  skipSuccessfulRequests: true, // only requests that "fail" count...
  requestWasSuccessful: (req, res) => res.statusCode !== 401, // ...and "fail" means HTTP 401
  handler: tooMany('Too many failed authentication attempts'),
});

/** Per API key (runs after authentication). */
export const keyLimiter = rateLimit({
  ...base,
  windowMs: config.rateLimit.windowMs,
  limit: config.rateLimit.max,
  keyGenerator: (req) => req.auth?.id ?? req.ip,
  handler: tooMany('API key rate limit exceeded'),
});
