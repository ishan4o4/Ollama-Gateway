// Zstd decompression stream: native zlib (Node >= 22.15 / 23.8) or the bundled pure-JS fallback.
import zlib from 'node:zlib';
import { Transform } from 'node:stream';

export function zstdStream() {
  if (typeof zlib.createZstdDecompress === 'function' && process.env.FORCE_JS_ZSTD !== '1') return zlib.createZstdDecompress();
  let dec;
  return new Transform({
    async construct(cb) {
      try {
        const { Decompress } = await import('fzstd');
        dec = new Decompress((chunk) => {
          if (chunk?.length) this.push(Buffer.from(chunk.buffer, chunk.byteOffset, chunk.length));
        });
        cb();
      } catch (e) { cb(e); }
    },
    transform(chunk, _enc, cb) {
      try { dec.push(chunk); cb(); } catch (e) { cb(e); }
    },
    flush(cb) {
      try { dec.push(new Uint8Array(0), true); cb(); } catch (e) { cb(e); }
    },
  });
}
