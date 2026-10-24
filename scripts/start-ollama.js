// Starts `ollama serve` with server-side caps taken from the same .env.
// Skips itself if Ollama is already running (e.g. as a systemd service).
import { spawn } from 'node:child_process';
import { config } from '../src/config.js';

const e = process.env;
const bin = e.OLLAMA_BIN || 'ollama';

// 1) Already running? Then there is nothing to start.
try {
  const r = await fetch(`${config.ollama.url}/api/version`, { signal: AbortSignal.timeout(1500) });
  if (r.ok) {
    console.log(`Ollama is already running at ${config.ollama.url} (v${(await r.json()).version}). Nothing to start.`);
    console.log('Its limits come from how that service was started; to change them see the README (systemctl edit ollama).');
    process.exit(0);
  }
} catch { /* not running, continue */ }

// 2) Start it with caps.
const env = {
  ...e,
  OLLAMA_HOST: e.OLLAMA_HOST || '127.0.0.1:11434',
  OLLAMA_NUM_PARALLEL: e.OLLAMA_NUM_PARALLEL || '1',
  OLLAMA_MAX_LOADED_MODELS: e.OLLAMA_MAX_LOADED_MODELS || '1',
  OLLAMA_MAX_QUEUE: e.OLLAMA_MAX_QUEUE || '16',
  OLLAMA_KEEP_ALIVE: String(config.keepAlive.value),
};
console.log('Starting ollama with:', Object.fromEntries(Object.entries(env).filter(([k]) => /^OLLAMA_(HOST|NUM|MAX|KEEP)/.test(k))));

const child = spawn(bin, ['serve'], { env, stdio: 'inherit' });
child.on('error', (err) => {
  if (err.code === 'ENOENT') {
    console.error(`\nCould not find "${bin}" on this machine.`);
    console.error('  • Not installed here?  Linux/macOS: curl -fsSL https://ollama.com/install.sh | sh   (Windows: https://ollama.com/download)');
    console.error('  • Installed elsewhere? Check with: which ollama   — then set OLLAMA_BIN=/full/path/to/ollama in .env');
    console.error('  • Running this on a different computer than where you installed it? Run it on the one that has Ollama.');
  } else {
    console.error(err);
  }
  process.exit(1);
});
child.on('exit', (code) => process.exit(code ?? 0));
for (const s of ['SIGINT', 'SIGTERM']) process.on(s, () => child.kill(s));
