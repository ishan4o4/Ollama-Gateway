import fs from 'node:fs';
import os from 'node:os';
import { pullModel } from '../runtime/ollamaRuntime.js';
import { config } from '../config.js';
import { slots } from '../middleware/concurrency.js';
import { keepAliveFor, loadModel, normName, unloadModel } from './models.js';
import { ollamaJson } from './ollama.js';
import { serverOptions } from './options.js';

const GB = 1024 ** 3;
// Rough CPU rule of thumb for 4-bit models: tokens/sec ≈ 7.5 × threads / billions of params.
// It only pre-filters; the real benchmark below has the final say.
const CPU_TPS_CONSTANT = 7.5;
const round = (n) => Math.round(n * 10) / 10;

function memoryBytes() {
  let total = os.totalmem();
  for (const f of ['/sys/fs/cgroup/memory.max', '/sys/fs/cgroup/memory/memory.limit_in_bytes']) {
    try {
      const n = Number(fs.readFileSync(f, 'utf8').trim()); // "max" -> NaN -> ignored
      if (Number.isFinite(n) && n > 0 && n < total) total = n; // respect container/cgroup limits
    } catch { /* not available */ }
  }
  return total;
}

function budget() {
  const totalGb = config.auto.ramGb ?? memoryBytes() / GB;
  return { totalGb: round(totalGb), budgetGb: round(Math.max(0, totalGb - config.auto.reserveGb)) };
}

const requiredGb = (m) => m.memoryGb * 1.25 + serverOptions(m).num_ctx / 1024 * 0.1; // weights + overhead + KV cache

async function benchmark(m) {
  const r = await ollamaJson('/api/generate', {
    body: {
      model: m.name,
      prompt: 'Write the numbers from one to forty in words.',
      stream: false,
      keep_alive: keepAliveFor(m),
      think: m.think,
      options: { ...serverOptions(m), num_predict: 48, temperature: 0 },
    },
    timeoutMs: 180_000,
  });
  if (!r.eval_count || !r.eval_duration) throw new Error('no timing data returned');
  return r.eval_count / (r.eval_duration / 1e9);
}

async function unloadOthers(keep) {
  try {
    const ps = await ollamaJson('/api/ps', { method: 'GET', timeoutMs: 5000 });
    for (const running of ps.models) {
      const m = [...config.models.registry.values()].find((x) => normName(x.name) === normName(running.name));
      if (m && m.name !== keep) await unloadModel(m).catch(() => {});
    }
  } catch { /* best effort */ }
}

async function run() {
  const { auto, limits } = config;
  const b = budget();
  const tags = await ollamaJson('/api/tags', { method: 'GET', timeoutMs: 5000 });
  const installed = new Set(tags.models.map((m) => normName(m.name)));

  const candidates = [...config.models.registry.values()]
    .filter((m) => m.quality && m.memoryGb && m.capabilities.some((c) => c === 'chat' || c === 'generate'))
    .sort((x, y) => y.quality - x.quality); // best first

  const report = [];
  let selected = null;

  for (const m of candidates) {
    const need = requiredGb(m);
    const threads = serverOptions(m).num_thread;
    const est = limits.maxNumGpu === 0 && m.paramsB ? (CPU_TPS_CONSTANT * threads) / m.paramsB : null;
    const entry = { model: m.name, needGb: round(need), estimatedTps: est === null ? null : round(est) };

    if (need > b.budgetGb) { report.push({ ...entry, result: `skipped (needs ~${round(need)}GB, ${b.budgetGb}GB usable)` }); continue; }
    if (est !== null && est < auto.minTps) { report.push({ ...entry, result: `skipped (estimated ${round(est)} tok/s < ${auto.minTps})` }); continue; }

    if (!installed.has(normName(m.name))) {
      if (!auto.pull) { report.push({ ...entry, result: 'skipped (not installed; set AUTO_PULL=true to download)' }); continue; }
      try {
        if (!(await pullModel(m.name))) throw new Error('download failed');
      } catch (e) { report.push({ ...entry, result: `skipped (pull failed: ${e.message})` }); continue; }
    }

    try {
      await loadModel(m);
      if (auto.benchmark) {
        const tps = await benchmark(m);
        entry.measuredTps = round(tps);
        if (tps < auto.minTps) {
          await unloadModel(m).catch(() => {});
          report.push({ ...entry, result: `skipped (measured ${round(tps)} tok/s < ${auto.minTps})` });
          continue;
        }
      }
      report.push({ ...entry, result: 'selected' });
      selected = m.name;
      break;
    } catch (e) {
      report.push({ ...entry, result: `skipped (load failed: ${e.message})` });
    }
  }

  if (selected) {
    config.models.default = selected; // "auto"/no-model requests now use this
    await unloadOthers(selected);
  }
  const state = { selected, at: new Date().toISOString(), budget: b, report };
  config.auto.state = state;
  return state;
}

/** Picks the highest-quality model that fits RAM and runs fast enough, loads it, and makes it the default. */
export async function selectBestModel() {
  const release = await slots.acquire(); // don't compete with live requests
  try { return await run(); } finally { release(); }
}
