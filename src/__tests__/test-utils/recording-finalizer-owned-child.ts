import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { IOS_SIMULATOR, createTestHostEnvironment } from '@agent-device/test-kit';
import { withCommandExecutorOverride } from '@agent-device/host-kit/command';
import { readProcessIdentityFacts } from '@agent-device/host-kit/process';
import { deviceIdentity } from '@agent-device/kernel/device';
import { AppError } from '@agent-device/kernel/errors';
import { localRuntimeOwner } from '@agent-device/contracts/platform-runtime';
import { createDurableResourceEnvelope } from '@agent-device/capture-kit';
import { createVideoValidatorPreparation } from '@agent-device/capture-kit/recording-video';
import { screenRecordingDurableResource } from '@agent-device/capture-kit/screen-recording-session-resource';
import {
  acquireDeviceClaim,
  admitRecordingStop,
  finishRecordingClaimRequest,
  reserveRecordingClaimFence,
} from '@agent-device/daemon-contracts/device-claims';
import { createScreenRecordingFinalizer } from '../../platform-runtime-screen-recording-finalizer-host.ts';

const [root, mode] = process.argv.slice(2);
if (!root || (mode !== 'warmup' && mode !== 'overlay'))
  throw new Error('missing fixture arguments');
Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true });
const stateDir = path.join(root, 'state');
const claimsDir = path.join(root, 'claims');
const cache = path.join(root, 'cache');
const host = createTestHostEnvironment({
  env: { ...process.env, AGENT_DEVICE_CLAIMS_DIR: claimsDir, AGENT_DEVICE_SWIFT_CACHE_DIR: cache },
});
const resourcePath = screenRecordingDurableResource.store.resolvePath(
  path.join(stateDir, 'sessions', 'recording'),
);
const owner = localRuntimeOwner('apple');
const fence = { token: 'fixture-fence', generation: 2 };
const acquired = await acquireDeviceClaim({
  device: IOS_SIMULATOR,
  session: 'recording',
  workspace: host.cwd,
  stateDir,
  env: host.env,
  reconcileOrphanedDeviceClaim: async () => ({ status: 'retained', reason: 'fixture' }),
});
if (acquired.status !== 'acquired') throw new Error('claim not acquired');
const context = {
  device: IOS_SIMULATOR,
  session: 'recording',
  workspace: host.cwd,
  stateDir,
  resourcePath,
  workspaceMatches: (workspace: string) => workspace === host.cwd,
  env: host.env,
};
await reserveRecordingClaimFence({ ...context, ownership: acquired.ownership, owner, fence });
screenRecordingDurableResource.store.write(
  resourcePath,
  createDurableResourceEnvelope({
    resourceKind: 'screen-recording',
    sessionId: 'recording',
    device: deviceIdentity(IOS_SIMULATOR),
    owner,
    fence,
    lifecycle: 'open',
    descriptor: { version: 1, body: {} },
    metadata: { deviceClaimToken: acquired.ownership.ownerToken },
  }),
);
await finishRecordingClaimRequest({
  ...context,
  ownership: acquired.ownership,
  action: 'start',
  succeeded: true,
  runtimeDisposed: true,
  startAttempted: true,
  expectedOwner: owner,
});
const stop = await admitRecordingStop({ ...context, owner, sessionOwnership: acquired.ownership });
const output = path.join(root, 'video.mp4');
fs.writeFileSync(output, Buffer.from('0000000c6674797069736f6d000000086d6f6f76', 'hex'));
const trigger = path.join(root, 'frontend-trigger');
const ready = path.join(root, 'frontend-ready');
let written = '';
const done = path.join(root, 'frontend-done');
let frontend: { pid: number; startTime: string } | undefined;
let notifyStarted!: () => void;
const started = new Promise<void>((resolve) => {
  notifyStarted = resolve;
});
const script = String.raw`
  const fs = require('node:fs');
  const [trigger, ready, written, done] = process.argv.slice(1);
  fs.writeFileSync(ready, 'ready');
  const poll = setInterval(() => {
    if (!fs.existsSync(trigger)) return;
    try {
      fs.mkdirSync(require('node:path').dirname(written), { recursive: true });
      fs.writeFileSync(written, 'late compiler write');
      fs.writeFileSync(done, 'wrote');
    } catch (error) {
      fs.writeFileSync(done, error.code);
    }
    clearInterval(poll);
  }, 10);
  setTimeout(() => { clearInterval(poll); fs.writeFileSync(done, 'expired'); }, 15000).unref();
`;
await withCommandExecutorOverride(
  (cmd, _args, options) => {
    if (cmd !== 'xcrun') return undefined;
    return (async () => {
      if (!options.cwd) throw new Error('compiler has no private working directory');
      written = path.join(options.cwd, 'frontend-late-write');
      const child = spawn(process.execPath, ['-e', script, trigger, ready, written, done], {
        detached: true,
        stdio: 'ignore',
      });
      if (!child.pid) throw new Error('frontend did not spawn');
      const facts = await readProcessIdentityFacts(child.pid);
      if (!facts.startTime) throw new Error('frontend identity unavailable');
      frontend = { pid: child.pid, startTime: facts.startTime };
      while (!fs.existsSync(ready)) await delay(10);
      notifyStarted();
      if (mode === 'overlay')
        throw new AppError('COMMAND_FAILED', 'compiler timeout', {
          timeoutMs: options.timeoutMs ?? 1,
        });
      return await new Promise<never>(() => {});
    })();
  },
  async () => {
    if (mode === 'warmup') {
      const finalizer = createScreenRecordingFinalizer(host, createVideoValidatorPreparation(host));
      await finalizer.prepare({ container: 'mp4' });
      await started;
    } else {
      stop.dispatch();
      const validator = {
        prepare: async () => ({ kind: 'container' as const }),
        read: () => Promise.resolve({ kind: 'container' as const }),
        close: async () => {},
      };
      const result = await createScreenRecordingFinalizer(host, validator).complete({
        outputPath: output,
        showTouches: true,
        gestureEvents: [{ kind: 'tap', tMs: 0, x: 1, y: 1 }],
        targetLabel: 'fixture',
      });
      if (!result.overlayWarning) throw new Error('expected timeout warning');
      await started;
    }
    process.stdout.write(`${JSON.stringify({ frontend, written, ownerPid: process.pid, mode })}\n`);
    await new Promise<void>(() => {});
  },
);
