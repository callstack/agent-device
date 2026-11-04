import fs from 'node:fs';
import path from 'node:path';
import { screenRecordingDurableResource } from '@agent-device/capture-kit/screen-recording-session-resource';
import { cleanupCrashFixture } from './recording-cleanup-crash.fixtures.ts';

const [stateDir, claimsDir, phase] = process.argv.slice(2);
if (!stateDir || !claimsDir || !phase) throw new Error('missing isolated child fixture paths');
function checkpoint(): never {
  fs.writeSync(process.stdout.fd, 'checkpoint\n');
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);
  throw new Error('unreachable');
}
if (phase === 'failed-disposal') {
  await cleanupCrashFixture(stateDir, claimsDir, true, true)
    .stop()
    .catch(() => {});
  checkpoint();
}
if (phase === 'active-app') {
  const result = await cleanupCrashFixture(stateDir, claimsDir, true, false, true, true).start();
  if (!result.ok) throw new Error(`recording start failed: ${JSON.stringify(result)}`);
  checkpoint();
}
if (phase === 'pending-native') {
  const fixture = cleanupCrashFixture(stateDir, claimsDir, true, false, false, true, true);
  const started = await fixture.start();
  if (!started.ok) throw new Error(`recording start failed: ${JSON.stringify(started)}`);
  const stopped = await fixture.stop();
  if (!stopped.ok) throw new Error(`recording stop failed: ${JSON.stringify(stopped)}`);
  checkpoint();
}
const resourcePath = screenRecordingDurableResource.store.resolvePath(
  path.join(stateDir, 'sessions', 'recording'),
);
const originalRename = fs.renameSync;
fs.renameSync = (from, to) => {
  const isClaim = path.dirname(String(to)) === claimsDir && String(to).endsWith('.json');
  if (isClaim && phase === 'stop-drained-retain') {
    const incoming = JSON.parse(fs.readFileSync(from, 'utf8')) as {
      recordingCleanupPending?: boolean;
      claimOwnerKind?: string;
    };
    if (incoming.claimOwnerKind === 'open-session' && !incoming.recordingCleanupPending)
      checkpoint();
  }
  originalRename(from, to);
  if (isClaim && phase === 'stop-prepared') {
    const claim = JSON.parse(fs.readFileSync(to, 'utf8')) as { recordingCleanupPending?: boolean };
    if (claim.recordingCleanupPending) checkpoint();
  }
  if (String(to) === resourcePath && phase.startsWith('stop-completed-')) {
    const record = screenRecordingDurableResource.store.read(resourcePath);
    if (record.status === 'decoded' && record.envelope.lifecycle === 'completed') checkpoint();
  }
};
const originalUnlink = fs.unlinkSync;
fs.unlinkSync = (target) => {
  if (
    phase === 'stop-drained-release' &&
    path.dirname(String(target)) === claimsDir &&
    String(target).endsWith('.json')
  )
    checkpoint();
  return originalUnlink(target);
};
const response = await cleanupCrashFixture(
  stateDir,
  claimsDir,
  true,
  false,
  phase.endsWith('-retain'),
).stop();
throw new Error(`fixture did not reach the requested checkpoint: ${JSON.stringify(response)}`);
