import './bootstrap.js'; // must stay first: creates .env + keys on first run
import { config } from './config.js';
import { startRuntime, stopRuntime, ensureDefaultModel } from './runtime/ollamaRuntime.js';
import { createApp } from './app.js';
import { preloadConfiguredModels } from './services/models.js';
import { selectBestModel } from './services/auto.js';

const server = createApp().listen(config.port, config.host, () => {
  console.log(`ollama-gateway listening on http://${config.host}:${config.port}`);
  console.log(`  default model : ${config.models.default}`);
  console.log(`  keep-alive    : ${config.keepAlive.mode} (${config.keepAlive.value})`);
  console.log(`  caps          : ctx<=${config.limits.maxNumCtx} predict<=${config.limits.maxNumPredict} threads<=${config.limits.maxNumThread} concurrent=${config.limits.maxConcurrent}`);
  if (config.auth.disabled) console.warn('  WARNING: AUTH_DISABLED=true — anyone who can reach this port has full access');
  else if (!['127.0.0.1', 'localhost', '::1'].includes(config.host)) console.warn('  NOTE: bound to a non-loopback address — put TLS (reverse proxy) in front of it');
  startup();
});

async function startup() {
  await startRuntime(); // finds/downloads/starts Ollama by itself
  let haveDefault = true;
  if (config.runtime.pullDefault && !config.auto.enabled) haveDefault = await ensureDefaultModel(config.models.default);
  if (!config.auto.enabled) {
    if (config.preloadOnStart && haveDefault) await preloadConfiguredModels();
    return;
  }
  for (let attempt = 1; attempt <= 6; attempt++) {
    try {
      const r = await selectBestModel();
      console.log(`[auto] RAM ${r.budget.totalGb}GB (usable ${r.budget.budgetGb}GB)`);
      for (const e of r.report) console.log(`[auto]   ${e.model}: ${e.result}`);
      console.log(r.selected ? `[auto] selected ${r.selected}` : `[auto] nothing suitable, staying on ${config.models.default}`);
      return;
    } catch (e) {
      console.error(`[auto] attempt ${attempt} failed: ${e.message}`);
      await new Promise((r) => setTimeout(r, 5000)); // Ollama may still be starting
    }
  }
}

server.requestTimeout = config.ollama.timeoutMs + 10_000;
server.headersTimeout = 15_000;

function shutdown(signal) {
  console.log(`${signal} received, shutting down...`);
  stopRuntime();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(1), 10_000).unref();
}
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
