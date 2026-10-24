import { config } from '../config.js';
import { ApiError } from '../errors.js';
import { ollamaJson } from './ollama.js';
import { serverOptions } from './options.js';
import { requireString } from '../validate.js';

export const normName = (n) => (n.includes(':') ? n : `${n}:latest`);

/** Maps a requested model name to an allowed model definition (or the default). */
export function resolveModel(requested, capability, { enforceChoice = true } = {}) {
  const { default: def, allowClientChoice, registry } = config.models;
  let name = def;
  if (requested !== undefined) {
    requireString(requested, 'model', 200);
    if (requested !== 'auto') { // "auto" = whatever the server currently considers best
      if (enforceChoice && !allowClientChoice && requested !== def) {
        throw new ApiError(403, 'model_choice_disabled', `This server only serves "${def}"`);
      }
      name = requested;
    }
  }
  const model = registry.get(name);
  if (!model) throw new ApiError(404, 'model_not_allowed', `Model "${name}" is not enabled on this server`);
  if (capability && !model.capabilities.includes(capability)) {
    throw new ApiError(400, 'unsupported_operation', `Model "${name}" does not support "${capability}"`);
  }
  return model;
}

/** Per-model setting wins, otherwise the global KEEP_ALIVE_MODE. */
export const keepAliveFor = (model) => model.keepAlive ?? config.keepAlive.value;

const isEmbedOnly = (m) => !m.capabilities.some((c) => c === 'chat' || c === 'generate');

/** Loads a model into memory with the same options real requests use (so it is not reloaded later). */
export async function loadModel(model, keepAlive = keepAliveFor(model), signal) {
  const options = serverOptions(model);
  const [path, body] = isEmbedOnly(model)
    ? ['/api/embed', { model: model.name, input: '', keep_alive: keepAlive, options }]
    : ['/api/generate', { model: model.name, keep_alive: keepAlive, options }];
  await ollamaJson(path, { body, signal, timeoutMs: 300_000 });
  return keepAlive;
}

export async function unloadModel(model, signal) {
  const [path, body] = isEmbedOnly(model)
    ? ['/api/embed', { model: model.name, input: '', keep_alive: 0 }]
    : ['/api/generate', { model: model.name, keep_alive: 0 }];
  await ollamaJson(path, { body, signal, timeoutMs: 60_000 });
}

export async function preloadConfiguredModels() {
  const all = [...config.models.registry.values()];
  let targets = all.filter((m) => m.preload);
  if (!targets.length) targets = [config.models.registry.get(config.models.default)];
  for (const m of targets) {
    try {
      const ka = await loadModel(m);
      console.log(`[preload] ${m.name} loaded (keep_alive=${ka})`);
    } catch (e) {
      console.error(`[preload] ${m.name} failed: ${e.message}`);
    }
  }
}
