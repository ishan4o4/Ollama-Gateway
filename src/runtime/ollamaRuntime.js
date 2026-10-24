// Makes the gateway self-contained: finds, downloads (first run only) and supervises its own
// Ollama process, so nothing has to be installed on the server by hand.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { config } from '../config.js';
import { zstdStream } from './zstd.js';

const rt = config.runtime;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const exe = process.platform === 'win32' ? 'ollama.exe' : 'ollama';
const GH = 'https://github.com/ollama/ollama/releases';

export const state = { mode: 'starting', managed: false, bin: null, version: null, error: null, restarts: 0 };
let child = null;
let stopping = false;

async function reachable(timeoutMs = 1500) {
  try {
    const r = await fetch(`${config.ollama.url}/api/version`, { signal: AbortSignal.timeout(timeoutMs) });
    if (!r.ok) return null;
    return (await r.json()).version ?? 'unknown';
  } catch { return null; }
}

function findBinary(dir) {
  if (!fs.existsSync(dir)) return null;
  const stack = [dir];
  while (stack.length) {
    const d = stack.pop();
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) stack.push(p);
      else if (e.name === exe) return p;
    }
  }
  return null;
}

function onPath() {
  const r = spawnSync(process.platform === 'win32' ? 'where' : 'which', ['ollama'], { encoding: 'utf8' });
  return r.status === 0 ? r.stdout.split(/\r?\n/)[0].trim() || null : null;
}

// ── which release files to download for this machine ──
function assetsFor() {
  const arch = process.arch === 'x64' ? 'amd64' : process.arch === 'arm64' ? 'arm64' : null;
  if (!arch) throw new Error(`Unsupported CPU architecture: ${process.arch}`);
  const rocm = rt.flavor === 'rocm' && !rt.cpuOnly;
  if (process.platform === 'linux') {
    const list = [`ollama-linux-${arch}.tar.zst`];
    if (rocm && arch === 'amd64') list.push('ollama-linux-amd64-rocm.tar.zst');
    return list;
  }
  if (process.platform === 'darwin') return ['ollama-darwin.tgz'];
  if (process.platform === 'win32') {
    const list = [`ollama-windows-${arch}.zip`];
    if (rocm && arch === 'amd64') list.push('ollama-windows-amd64-rocm.zip');
    return list;
  }
  throw new Error(`Unsupported OS: ${process.platform}`);
}

async function downloadTo(url, file, expectedSha) {
  const res = await fetch(url, { redirect: 'follow' });
  if (!res.ok || !res.body) throw new Error(`Download failed (${res.status}) ${url}`);
  const total = Number(res.headers.get('content-length')) || 0;
  const hash = crypto.createHash('sha256');
  let got = 0, lastLog = 0;
  const meter = new Transform({
    transform(chunk, _e, cb) {
      hash.update(chunk); got += chunk.length;
      const now = Date.now();
      if (now - lastLog > 5000) {
        lastLog = now;
        console.log(`[ollama] downloading… ${(got / 1048576).toFixed(0)}${total ? ` / ${(total / 1048576).toFixed(0)}` : ''} MB`);
      }
      cb(null, chunk);
    },
  });
  await pipeline(Readable.fromWeb(res.body), meter, fs.createWriteStream(file));
  const sum = hash.digest('hex');
  if (expectedSha && sum !== expectedSha) throw new Error(`Checksum mismatch for ${path.basename(file)}`);
}

const GPU_DIR = /(^|[\\/])lib[\\/]ollama[\\/](cuda|rocm|vulkan|mlx)[^\\/]*([\\/]|$)/i;

function stripGpuLibs(dir) {
  const base = path.join(dir, 'lib', 'ollama');
  if (!fs.existsSync(base)) return;
  for (const e of fs.readdirSync(base, { withFileTypes: true })) {
    if (e.isDirectory() && /^(cuda|rocm|vulkan|mlx)/i.test(e.name)) fs.rmSync(path.join(base, e.name), { recursive: true, force: true });
  }
}

async function extract(file, dest) {
  fs.mkdirSync(dest, { recursive: true });
  const { x } = await import('tar');
  if (file.endsWith('.tar.zst')) {
    await pipeline(fs.createReadStream(file), zstdStream(), x({ C: dest, filter: (p) => !(rt.cpuOnly && GPU_DIR.test(p)) }));
  } else if (file.endsWith('.tgz')) {
    await x({ file, C: dest, filter: (p) => !(rt.cpuOnly && GPU_DIR.test(p)) });
  } else if (file.endsWith('.zip')) {
    const r = spawnSync('tar', ['-xf', file, '-C', dest], { stdio: 'inherit' }); // bsdtar ships with Windows 10+
    if (r.status !== 0) throw new Error('Could not extract the .zip (Windows needs the built-in tar.exe)');
  } else throw new Error(`Unknown archive type: ${file}`);
}

async function install() {
  const tag = rt.version === 'latest' ? 'latest/download' : `download/${rt.version}`;
  let sums = {};
  try {
    const t = await (await fetch(`${GH}/${tag}/sha256sum.txt`, { redirect: 'follow' })).text();
    for (const line of t.split('\n')) { const [h, n] = line.trim().split(/\s+/); if (h && n) sums[n.replace(/^\*/, '')] = h; }
  } catch { console.warn('[ollama] could not fetch checksums, continuing without verification'); }

  const installDir = path.join(rt.dir, 'ollama');
  const tmp = path.join(rt.dir, 'tmp');
  fs.rmSync(installDir, { recursive: true, force: true });
  fs.mkdirSync(tmp, { recursive: true });
  for (const name of assetsFor()) {
    const archive = path.join(tmp, name);
    console.log(`[ollama] first run: downloading ${name} (large, one time only)`);
    await downloadTo(`${GH}/${tag}/${name}`, archive, sums[name]);
    console.log(`[ollama] extracting ${name}`);
    await extract(archive, installDir);
    if (rt.cpuOnly) stripGpuLibs(installDir); // also covers .zip extraction
    fs.rmSync(archive, { force: true });
  }
  fs.rmSync(tmp, { recursive: true, force: true });
  const bin = findBinary(installDir);
  if (!bin) throw new Error('Ollama binary not found after extraction');
  if (process.platform !== 'win32') fs.chmodSync(bin, 0o755);
  return bin;
}

async function resolveBinary() {
  if (rt.bin) return rt.bin;
  const local = findBinary(path.join(rt.dir, 'ollama'));
  if (local) return local;
  const system = onPath();
  if (system) return system;
  if (!rt.autoDownload) throw new Error('Ollama not found and OLLAMA_AUTO_DOWNLOAD=false');
  return install();
}

function spawnOllama(bin) {
  const e = process.env;
  const url = new URL(config.ollama.url);
  const cpu = rt.cpuOnly ? { CUDA_VISIBLE_DEVICES: '-1', HIP_VISIBLE_DEVICES: '-1', ROCR_VISIBLE_DEVICES: '-1', GGML_VK_VISIBLE_DEVICES: '-1', OLLAMA_LLM_LIBRARY: 'cpu' } : {};
  const env = {
    ...e,
    ...cpu,
    OLLAMA_HOST: `${url.hostname}:${url.port || 11434}`,
    OLLAMA_MODELS: rt.modelsDir,
    OLLAMA_NUM_PARALLEL: e.OLLAMA_NUM_PARALLEL || '1',
    OLLAMA_MAX_LOADED_MODELS: e.OLLAMA_MAX_LOADED_MODELS || '1',
    OLLAMA_MAX_QUEUE: e.OLLAMA_MAX_QUEUE || '16',
    OLLAMA_KEEP_ALIVE: String(config.keepAlive.value),
  };
  child = spawn(bin, ['serve'], { env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  const pipeLog = (s) => s.on('data', (d) => rt.verbose && process.stdout.write(`[ollama] ${d}`));
  pipeLog(child.stdout); pipeLog(child.stderr);
  child.on('exit', (code, sig) => {
    child = null;
    if (stopping) return;
    state.mode = 'restarting';
    state.restarts++;
    console.error(`[ollama] exited (${sig ?? code}); restarting in 3s`);
    setTimeout(() => !stopping && spawnOllama(bin), 3000);
  });
  child.on('error', (err) => { state.error = err.message; console.error('[ollama] failed to start:', err.message); });
}

/** Call once at startup. Resolves when Ollama answers on config.ollama.url. */
export async function startRuntime() {
  const existing = await reachable();
  if (existing) {
    Object.assign(state, { mode: 'external', managed: false, version: existing });
    console.log(`[ollama] using already running Ollama v${existing} at ${config.ollama.url}`);
    return;
  }
  if (!rt.manage) {
    state.mode = 'unavailable';
    console.warn(`[ollama] nothing at ${config.ollama.url} and MANAGE_OLLAMA=false`);
    return;
  }
  try {
    fs.mkdirSync(rt.modelsDir, { recursive: true });
    const bin = await resolveBinary();
    state.bin = bin;
    spawnOllama(bin);
    state.managed = true;
    for (let i = 0; i < 120; i++) {
      const v = await reachable(1000);
      if (v) { Object.assign(state, { mode: 'managed', version: v }); console.log(`[ollama] ready (v${v}, ${rt.cpuOnly ? 'CPU only, ' : ''}models in ${rt.modelsDir})`); return; }
      if (!child && stopping) return;
      await sleep(1000);
    }
    throw new Error('Ollama did not become ready within 2 minutes');
  } catch (e) {
    state.mode = 'error'; state.error = e.message;
    console.error(`[ollama] ${e.message}`);
  }
}

export function stopRuntime() {
  stopping = true;
  if (child) child.kill('SIGTERM');
}

/** Download the default model if it is not installed yet (so first request just works). */
export async function ensureDefaultModel(name) {
  try {
    const tags = await (await fetch(`${config.ollama.url}/api/tags`)).json();
    const have = (tags.models ?? []).some((m) => m.name === name || m.name === `${name}:latest`);
    if (have) return;
    console.log(`[ollama] pulling default model ${name} (first run)…`);
    const r = await fetch(`${config.ollama.url}/api/pull`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: name, stream: false }), signal: AbortSignal.timeout(config.ollama.pullTimeoutMs),
    });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    console.log(`[ollama] ${name} ready`);
  } catch (e) {
    console.error(`[ollama] could not pull ${name}: ${e.message}`);
  }
}
