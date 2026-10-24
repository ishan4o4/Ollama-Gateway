import { config } from '../config.js';
import { bad, isPlainObject } from '../validate.js';

/** Sampling options a client may set. Everything else (num_ctx, num_thread, num_gpu...) is server-controlled. */
const CLIENT_NUMERIC = {
  temperature: { min: 0, max: 2 },
  top_p: { min: 0, max: 1 },
  top_k: { min: 1, max: 500, int: true },
  repeat_penalty: { min: 0, max: 3 },
  seed: { min: 0, max: 2 ** 31 - 1, int: true },
  num_predict: { min: 1, max: Number.MAX_SAFE_INTEGER, int: true },
};

const cap = (value, max) => (max === undefined ? value : Math.min(value ?? max, max));

/**
 * Resource-related options come from models.json but are always clamped to the env caps.
 * They are identical for every request so Ollama never reloads the model because options changed.
 */
export function serverOptions(model) {
  const { limits } = config;
  const o = { ...model.options };
  o.num_ctx = cap(o.num_ctx, limits.maxNumCtx);
  o.num_thread = cap(o.num_thread, limits.maxNumThread);
  o.num_predict = cap(o.num_predict, limits.maxNumPredict);
  if (limits.maxNumGpu !== undefined) o.num_gpu = cap(o.num_gpu, limits.maxNumGpu);
  if (limits.maxNumBatch !== undefined) o.num_batch = cap(o.num_batch, limits.maxNumBatch);
  return o;
}

export function buildOptions(model, client) {
  const out = serverOptions(model);
  if (client === undefined) return out;
  if (!isPlainObject(client)) throw bad('"options" must be an object');

  for (const [key, value] of Object.entries(client)) {
    if (key === 'stop') {
      if (!Array.isArray(value) || value.length > 4 || !value.every((s) => typeof s === 'string' && s.length <= 64)) {
        throw bad('"options.stop" must be an array of up to 4 short strings');
      }
      out.stop = value;
      continue;
    }
    const spec = CLIENT_NUMERIC[key];
    if (!spec) throw bad(`Option "${key}" is not allowed`);
    if (typeof value !== 'number' || !Number.isFinite(value) || (spec.int && !Number.isInteger(value))) {
      throw bad(`Option "${key}" must be ${spec.int ? 'an integer' : 'a number'}`);
    }
    if (value < spec.min || value > spec.max) throw bad(`Option "${key}" must be between ${spec.min} and ${spec.max}`);
    out[key] = value;
  }
  out.num_predict = Math.min(out.num_predict, config.limits.maxNumPredict);
  return out;
}
