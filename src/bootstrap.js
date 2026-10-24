// Runs before anything else: creates .env on first start and generates API keys,
// so the very first `node src/server.js` works with zero manual setup.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const envFile = path.join(root, '.env');
const example = path.join(root, '.env.example');
const key = () => crypto.randomBytes(32).toString('hex');

if (!fs.existsSync(envFile) && fs.existsSync(example)) {
  const apiKey = key();
  const adminKey = key();
  const text = fs.readFileSync(example, 'utf8')
    .replace(/^API_KEYS=.*$/m, `API_KEYS=${apiKey}`)
    .replace(/^ADMIN_API_KEYS=.*$/m, `ADMIN_API_KEYS=${adminKey}`);
  fs.writeFileSync(envFile, text, { mode: 0o600 });
  console.log('────────────────────────────────────────────────────────────');
  console.log(' First start: created .env and generated your API keys');
  console.log(`   API key   : ${apiKey}`);
  console.log(`   Admin key : ${adminKey}`);
  console.log(' They are saved in .env (shown only this once in the log).');
  console.log('────────────────────────────────────────────────────────────');
}
