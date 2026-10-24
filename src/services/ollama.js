import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { config } from '../config.js';
import { ApiError } from '../errors.js';

export async function ollamaFetch(path, { method = 'POST', body, signal, timeoutMs = config.ollama.timeoutMs } = {}) {
  const signals = [AbortSignal.timeout(timeoutMs)];
  if (signal) signals.push(signal);

  let upstream;
  try {
    upstream = await fetch(config.ollama.url + path, {
      method,
      headers: body ? { 'content-type': 'application/json' } : undefined,
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.any(signals),
    });
  } catch (err) {
    if (signal?.aborted) throw new ApiError(499, 'client_closed', 'Client closed the request');
    if (err?.name === 'TimeoutError') throw new ApiError(504, 'upstream_timeout', 'Ollama did not respond in time');
    throw new ApiError(502, 'upstream_unreachable', 'Cannot reach the Ollama server');
  }

  if (!upstream.ok) {
    let message = 'Ollama returned an error';
    try { message = (await upstream.json()).error || message; } catch { /* ignore */ }
    throw new ApiError(upstream.status === 404 ? 404 : 502, 'upstream_error', message);
  }
  return upstream;
}

export async function ollamaJson(path, opts) {
  return (await ollamaFetch(path, opts)).json();
}

/** Aborts the upstream call if the client disconnects before the response completes. */
export function abortOnClose(res) {
  const ac = new AbortController();
  res.once('close', () => { if (!res.writableFinished) ac.abort(); });
  return ac.signal;
}

export async function pipeStream(upstream, res) {
  res.status(200);
  res.setHeader('Content-Type', 'application/x-ndjson; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Accel-Buffering', 'no');
  await pipeline(Readable.fromWeb(upstream.body), res);
}
