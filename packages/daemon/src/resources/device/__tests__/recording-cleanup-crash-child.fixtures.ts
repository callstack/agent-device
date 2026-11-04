import fs from 'node:fs';
import path from 'node:path';
import { cleanupCrashFixture } from './recording-cleanup-crash.fixtures.ts';

const [stateDir, claimsDir, phase] = process.argv.slice(2);
if (!stateDir || !claimsDir || !phase) throw new Error('missing isolated child fixture paths');
if (phase === 'failed-disposal' || phase === 'unsupported-binding') {
  await cleanupCrashFixture(stateDir, claimsDir, true, true, false, phase === 'failed-disposal')
    .stop()
    .catch(() => {});
  fs.writeSync(process.stdout.fd, 'checkpoint\n');
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);
}
const originalRename = fs.renameSync;
fs.renameSync = (from, to) => {
  originalRename(from, to);
  if (path.dirname(String(to)) !== claimsDir || !String(to).endsWith('.json')) return;
  const claim = JSON.parse(fs.readFileSync(to, 'utf8')) as { recordingCleanupProof?: string };
  if (claim.recordingCleanupProof !== phase) return;
  fs.writeSync(process.stdout.fd, 'checkpoint\n');
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);
};
const response = await cleanupCrashFixture(
  stateDir,
  claimsDir,
  true,
  false,
  phase.endsWith('-retain'),
).stop();
throw new Error(`fixture did not reach the requested checkpoint: ${JSON.stringify(response)}`);
