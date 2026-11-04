import fs from 'node:fs';
import path from 'node:path';
import { createSwiftAttempt } from '../../swift-attempt.ts';
const [root] = process.argv.slice(2);
if (!root) throw new Error('missing root');
const env = {
  ...process.env,
  AGENT_DEVICE_SWIFT_CACHE_DIR: path.join(root, 'cache'),
  AGENT_DEVICE_CLAIMS_DIR: path.join(root, 'claims'),
};
const attempts: string[] = [];
for (let index = 0; index < 12; index++) {
  const attempt = createSwiftAttempt(env, 'compiler');
  fs.writeFileSync(path.join(attempt.work, 'large'), Buffer.alloc(256 * 1024));
  attempts.push(path.basename(attempt.directory));
}
process.stdout.write(`${JSON.stringify({ attempts })}\n`);
await new Promise<void>(() => {});
