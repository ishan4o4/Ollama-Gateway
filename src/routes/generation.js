import { Router } from 'express';
import { config } from '../config.js';
import { acquireSlot } from '../middleware/concurrency.js';
import { abortOnClose, ollamaFetch, pipeStream } from '../services/ollama.js';
import { keepAliveFor, resolveModel } from '../services/models.js';
import { buildOptions, serverOptions } from '../services/options.js';
import { bad, optionalBool, optionalString, requireString } from '../validate.js';

const router = Router();
const { limits } = config;

/** Takes a concurrency slot, calls Ollama, and either streams (NDJSON) or returns JSON. */
async function run(req, res, path, payload, stream) {
  await acquireSlot(req, res);
  const upstream = await ollamaFetch(path, { body: payload, signal: abortOnClose(res) });
  if (stream) return pipeStream(upstream, res);
  res.json(await upstream.json());
}

function parseMessages(v) {
  if (!Array.isArray(v) || v.length === 0 || v.length > limits.maxMessages) {
    throw bad(`"messages" must be an array with 1-${limits.maxMessages} items`);
  }
  let total = 0;
  return v.map((m, i) => {
    if (!m || typeof m !== 'object' || !['system', 'user', 'assistant'].includes(m.role)) {
      throw bad(`messages[${i}].role must be system, user or assistant`);
    }
    if (typeof m.content !== 'string') throw bad(`messages[${i}].content must be a string`);
    total += m.content.length;
    if (total > limits.maxPromptChars) throw bad(`Total message content exceeds ${limits.maxPromptChars} characters`);
    return { role: m.role, content: m.content };
  });
}

function parseFormat(v) {
  if (v === undefined) return undefined;
  if (v !== 'json') throw bad('"format" may only be "json"');
  return v;
}

// POST /v1/generate  { model?, prompt, system?, stream?, format?, options? }
router.post('/generate', async (req, res) => {
  const b = req.body ?? {};
  const model = resolveModel(b.model, 'generate');
  const stream = optionalBool(b.stream, 'stream', false);
  const payload = {
    model: model.name,
    prompt: requireString(b.prompt, 'prompt', limits.maxPromptChars),
    system: optionalString(b.system, 'system', limits.maxPromptChars),
    format: parseFormat(b.format),
    options: buildOptions(model, b.options),
    keep_alive: keepAliveFor(model),
    think: model.think, // false = skip reasoning (much faster on CPU); omitted if unset
    stream,
  };
  await run(req, res, '/api/generate', payload, stream);
});

// POST /v1/chat  { model?, messages[], stream?, format?, options? }
router.post('/chat', async (req, res) => {
  const b = req.body ?? {};
  const model = resolveModel(b.model, 'chat');
  const stream = optionalBool(b.stream, 'stream', false);
  const payload = {
    model: model.name,
    messages: parseMessages(b.messages),
    format: parseFormat(b.format),
    options: buildOptions(model, b.options),
    keep_alive: keepAliveFor(model),
    think: model.think, // false = skip reasoning (much faster on CPU); omitted if unset
    stream,
  };
  await run(req, res, '/api/chat', payload, stream);
});

// POST /v1/embeddings  { model?, input: string | string[] }
router.post('/embeddings', async (req, res) => {
  const b = req.body ?? {};
  const model = resolveModel(b.model, 'embed');
  const raw = Array.isArray(b.input) ? b.input : [b.input];
  if (raw.length === 0 || raw.length > limits.maxEmbedInputs) {
    throw bad(`"input" must contain 1-${limits.maxEmbedInputs} strings`);
  }
  let total = 0;
  const input = raw.map((s, i) => {
    const v = requireString(s, `input[${i}]`, limits.maxPromptChars);
    total += v.length;
    if (total > limits.maxPromptChars) throw bad(`Total input exceeds ${limits.maxPromptChars} characters`);
    return v;
  });
  const payload = {
    model: model.name,
    input,
    options: serverOptions(model),
    keep_alive: keepAliveFor(model),
  };
  await run(req, res, '/api/embed', payload, false);
});

export default router;
