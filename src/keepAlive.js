const DURATION = /^(\d+(\.\d+)?(ms|s|m|h))+$/;

/** Returns a number (seconds, -1 = forever, 0 = unload now) or a Go-style duration string. */
export function normalizeKeepAlive(v) {
  if (typeof v === 'number' && Number.isFinite(v)) return v < 0 ? -1 : Math.trunc(v);
  if (typeof v === 'string') {
    const s = v.trim();
    if (/^-?\d+$/.test(s)) return normalizeKeepAlive(Number(s));
    if (DURATION.test(s)) return s;
  }
  throw new Error(`Invalid keep_alive "${v}" (use -1, 0, seconds, or a duration like "10m")`);
}
