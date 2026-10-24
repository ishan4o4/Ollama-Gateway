import 'dotenv/config';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { normalizeKeepAlive } from './keepAlive.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const env = process.env;

function fail(msg) {
  console.error(`[config] ${msg}`);
  process.exit(1);
}

const has = (name) => env[name] !== undefined && env[name].trim() !== '';

function int(name, def, min = 0, max = Number.MAX_SAFE_INTEGER) {
  if (!has(name)) return def;
  const n = Number(env[name]);
  if (!Number.isInteger(n) || n < min || n > max) fail(`${name} must be an integer between ${min} and ${max}`);
  return n;
}

function num(name, def, min = 0) {
  if (!has(name)) return def;
  const n = Number(env[name]);
  if (!Number.isFinite(n) || n < min) fail(`${name} must be a number >= ${min}`);
  return n;
}

function bool(name, def = false) {
  if (!has(name)) return def;
  return ['1', 'true', 'yes', 'on'].includes(env[name].trim().toLowerCase());
}

function list(name) {
  return (env[name] || '').split(',').map((s) => s.trim()).filter(Boolean);
}

function duration(name, def) {
  try {
    return normalizeKeepAlive(has(name) ? env[name] : def);
  } catch (e) {
    return fail(`${name}: ${e.message}`);
  }
}

// ── auth ──
const authDisabled = bool('AUTH_DISABLED');
const apiKeys = list('API_KEYS');
const adminKeys = list('ADMIN_API_KEYS');
if (!authDisabled) {
  if (!apiKeys.length && !adminKeys.length) fail('Set API_KEYS (or ADMIN_API_KEYS) in .env — or AUTH_DISABLED=true for local testing.');
  for (const k of [...apiKeys, ...adminKeys]) if (k.length < 24) fail('Every API key must be at least 24 characters (run: npm run genkey).');
}

// ── keep-alive (permanent or not) ──
const mode = (env.KEEP_ALIVE_MODE || 'timed').trim().toLowerCase();
if (!['permanent', 'timed', 'unload'].includes(mode)) fail('KEEP_ALIVE_MODE must be permanent | timed | unload');
const timed = duration('KEEP_ALIVE_DURATION', '5m');
const keepAliveValue = mode === 'permanent' ? -1 : mode === 'unload' ? 0 : timed;

function posNum(model, field, v) {
  if (v === undefined) return undefined;
  if (typeof v !== 'number' || !(v > 0)) fail(`${model}: ${field} must be a positive number`);
  return v;
}

function thinkFlag(model, v) {
  if (typeof v !== 'boolean') fail(`${model}: think must be true or false`);
  return v;
}

// ── models registry ──
function loadModels() {
  const file = path.resolve(root, env.MODELS_CONFIG || 'config/models.json');
  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    return fail(`Cannot read models config ${file}: ${e.message}`);
  }
  if (!raw?.models || typeof raw.models !== 'object' || !Object.keys(raw.models).length) {
    fail('models config must define at least one model');
  }
  const registry = new Map();
  for (const [name, m] of Object.entries(raw.models)) {
    const capabilities = m.capabilities ?? ['chat', 'generate'];
    if (!Array.isArray(capabilities) || !capabilities.every((c) => ['chat', 'generate', 'embed'].includes(c))) {
      fail(`${name}: capabilities must be a subset of chat | generate | embed`);
    }
    let keepAlive;
    if (m.keepAlive !== undefined && m.keepAlive !== null) {
      try { keepAlive = normalizeKeepAlive(m.keepAlive); } catch (e) { fail(`${name}: ${e.message}`); }
    }
    registry.set(name, {
      name,
      description: m.description ?? '',
      capabilities,
      keepAlive,
      preload: m.preload === true,
      think: m.think === undefined ? undefined : thinkFlag(name, m.think),
      memoryGb: posNum(name, 'memoryGb', m.memoryGb),
      paramsB: posNum(name, 'paramsB', m.paramsB),
      quality: posNum(name, 'quality', m.quality),
      options: m.options && typeof m.options === 'object' ? m.options : {},
    });
  }
  const def = has('DEFAULT_MODEL') ? env.DEFAULT_MODEL.trim() : raw.defaultModel;
  if (!registry.has(def)) fail(`Default model "${def}" is not defined in the models config`);
  return { default: def, allowClientChoice: bool('ALLOW_CLIENT_MODEL_CHOICE', true), registry };
}

const cores = os.availableParallelism?.() ?? os.cpus().length;
const trustProxy = !has('TRUST_PROXY') ? false : /^\d+$/.test(env.TRUST_PROXY) ? Number(env.TRUST_PROXY) : env.TRUST_PROXY;

export const config = {
  env: env.NODE_ENV || 'development',
  host: env.HOST || '127.0.0.1',
  port: int('PORT', 3000, 1, 65535),
  trustProxy,
  cors: { origins: list('CORS_ORIGINS') },
  bodyLimitKb: int('MAX_BODY_KB', 256, 1, 10240),
  auth: { disabled: authDisabled, apiKeys, adminKeys },
  rateLimit: {
    windowMs: int('RATE_LIMIT_WINDOW_MS', 60_000, 1000),
    max: int('RATE_LIMIT_MAX', 30, 1),
    ipMax: int('IP_RATE_LIMIT_MAX', 300, 1),
    authFailMax: int('AUTH_FAIL_MAX', 10, 1),
  },
  ollama: {
    url: (env.OLLAMA_URL || 'http://127.0.0.1:11434').replace(/\/+$/, ''),
    timeoutMs: int('REQUEST_TIMEOUT_MS', 120_000, 1000),
    pullTimeoutMs: int('PULL_TIMEOUT_MS', 900_000, 1000),
  },
  runtime: {
    manage: bool('MANAGE_OLLAMA', true), // gateway downloads + runs its own Ollama when none is running
    autoDownload: bool('OLLAMA_AUTO_DOWNLOAD', true),
    version: (env.OLLAMA_VERSION || 'latest').trim(),
    flavor: (env.OLLAMA_FLAVOR || '').trim().toLowerCase(), // '' (CPU/NVIDIA) or 'rocm' (AMD)
    bin: has('OLLAMA_BIN') ? env.OLLAMA_BIN.trim() : undefined,
    dir: path.resolve(root, env.DATA_DIR || 'data'),
    modelsDir: path.resolve(root, env.DATA_DIR || 'data', 'models'),
    pullDefault: bool('PULL_DEFAULT_MODEL', true),
    verbose: bool('OLLAMA_LOGS', false),
    cpuOnly: bool('CPU_ONLY', true), // no GPU libraries kept, GPU hidden from Ollama, num_gpu forced to 0
  },
  keepAlive: { mode, value: keepAliveValue, timed },
  preloadOnStart: bool('PRELOAD_ON_START'),
  auto: {
    enabled: bool('AUTO_MODEL'),
    ramGb: has('AUTO_RAM_GB') ? num('AUTO_RAM_GB', 0, 0.5) : undefined, // override detected RAM
    reserveGb: num('AUTO_RESERVE_GB', 2, 0), // left free for OS, Node, your bot
    minTps: num('AUTO_MIN_TPS', 3, 0.1), // minimum acceptable tokens/second
    benchmark: bool('AUTO_BENCHMARK', true),
    pull: bool('AUTO_PULL', false),
    state: null, // filled in by the selector
  },
  limits: {
    maxConcurrent: int('MAX_CONCURRENT', 1, 1),
    maxQueue: int('MAX_QUEUE', 10, 0),
    queueTimeoutMs: int('QUEUE_TIMEOUT_MS', 30_000, 100),
    maxNumCtx: int('MAX_NUM_CTX', 4096, 128),
    maxNumPredict: int('MAX_NUM_PREDICT', 512, 1),
    maxNumThread: int('MAX_NUM_THREAD', Math.max(1, Math.floor(cores / 2)), 1),
    maxNumGpu: has('MAX_NUM_GPU') ? int('MAX_NUM_GPU', 0, 0) : (bool('CPU_ONLY', true) ? 0 : undefined),
    maxNumBatch: has('MAX_NUM_BATCH') ? int('MAX_NUM_BATCH', 512, 1) : undefined,
    maxPromptChars: int('MAX_PROMPT_CHARS', 32_000, 1),
    maxMessages: int('MAX_MESSAGES', 50, 1),
    maxEmbedInputs: int('MAX_EMBED_INPUTS', 64, 1),
  },
  models: loadModels(),
};
