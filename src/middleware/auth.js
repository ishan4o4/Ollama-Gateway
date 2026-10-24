import crypto from 'node:crypto';
import { config } from '../config.js';
import { ApiError } from '../errors.js';

// Keys are hashed once at startup; comparisons are constant-time on fixed-length digests.
const digest = (s) => crypto.createHash('sha256').update(s).digest();
const userKeys = config.auth.apiKeys.map(digest);
const adminKeys = config.auth.adminKeys.map(digest);

function matches(list, d) {
  let ok = false;
  for (const k of list) if (crypto.timingSafeEqual(k, d)) ok = true; // no early exit
  return ok;
}

function extractKey(req) {
  const x = req.get('x-api-key');
  if (x) return x.trim();
  const a = req.get('authorization');
  if (a && /^Bearer\s+/i.test(a)) return a.replace(/^Bearer\s+/i, '').trim();
  return null;
}

export function authenticate(req, res, next) {
  if (config.auth.disabled) {
    req.auth = { role: 'admin', id: 'anonymous' };
    return next();
  }
  const key = extractKey(req);
  const d = key && key.length <= 512 ? digest(key) : null;
  const role = d ? (matches(adminKeys, d) ? 'admin' : matches(userKeys, d) ? 'user' : null) : null;
  if (!role) {
    res.set('WWW-Authenticate', 'Bearer');
    throw new ApiError(401, 'unauthorized', 'Missing or invalid API key');
  }
  req.auth = { role, id: d.toString('hex').slice(0, 12) }; // short fingerprint, safe to log
  next();
}

export function requireAdmin(req, res, next) {
  if (req.auth?.role !== 'admin') throw new ApiError(403, 'forbidden', 'An admin API key is required');
  next();
}
