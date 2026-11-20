import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, expect, test } from 'vitest';
import { acquireProcessLock } from '@agent-device/host-kit/file';
import { mkdtempForTestSync } from '@agent-device/test-kit';
import type { DeviceInfo } from '@agent-device/kernel/device';
import { canonicalLocalDeviceKey } from './device-claim-paths.ts';
import { acquireDeviceClaim } from './device-claims.ts';
import { withDeviceClaimLockHeld } from './device-claim-store.ts';

// This case measures one process excluding another out of a lock, which the lock judges from the
// owner's real process identity. `pinOwnProcessStartTime` would pin the record to a start time the
// lock's own probe contradicts, and the contender would be right to reclaim the lock.

const device: DeviceInfo = {
  platform: 'android',
  id: 'emulator-5554',
  name: 'Pixel',
  kind: 'emulator',
  booted: true,
};

const deviceKey = canonicalLocalDeviceKey(device);

const roots: string[] = [];

afterEach(() => {
  delete process.env.AGENT_DEVICE_CLAIMS_DIR;
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

/** A private claims root, plus the state dir an acquisition in this case would claim from. */
function useClaimStore(): string {
  const root = mkdtempForTestSync('agent-device-claim-lock-');
  roots.push(root);
  process.env.AGENT_DEVICE_CLAIMS_DIR = path.join(root, 'claims');
  return root;
}

function claimFilePath(): string {
  const hash = crypto.createHash('sha256').update(deviceKey).digest('hex');
  return path.join(process.env.AGENT_DEVICE_CLAIMS_DIR!, `${hash}.json`);
}

function acquireContendingClaim(stateDir: string) {
  return acquireDeviceClaim({
    env: process.env,
    device,
    session: 'contender',
    workspace: '/workspaces/contender',
    stateDir,
    reconcileOrphanedDeviceClaim: async () => ({ status: 'retained', reason: 'test-no-recovery' }),
  });
}

test('holds the device claim lock so a contending acquisition cannot complete', async () => {
  const stateDir = useClaimStore();
  let contenderSettled = false;
  let contender: ReturnType<typeof acquireContendingClaim> | undefined;

  const held = await withDeviceClaimLockHeld(deviceKey, process.env, async () => {
    // Started while this callback runs, so acquisition is reaching for a lock this task holds.
    contender = acquireContendingClaim(stateDir).then((result) => {
      contenderSettled = true;
      return result;
    });
    // The lock is still ours while we look, so these two answers cannot be a race this test won:
    // while a caller holds this lock no owner can be recorded for the device, which is the
    // exclusion #4764's stop needs between "nothing conflicts" and the signal.
    await settleTurns();
    expect(contenderSettled).toBe(false);
    expect(fs.existsSync(claimFilePath())).toBe(false);
    return 'callback-finished';
  });

  expect(held).toEqual({ status: 'ran', result: 'callback-finished' });
  // Once released, the same acquisition goes through, so the lock is not poisoned by this caller.
  expect(await contender).toMatchObject({ status: 'acquired' });
  expect(fs.existsSync(claimFilePath())).toBe(true);
});

/**
 * Gives the contending acquisition its turns: it reads process identity and the lock owner before it
 * attempts, then waits one poll interval. Uncontended, it writes the claim well inside this budget, so
 * the assertions that follow measure the exclusion rather than a race this test won.
 */
async function settleTurns(): Promise<void> {
  for (let turn = 0; turn < 5; turn += 1) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

test('reports a conflict and runs nothing while the device lock is held', async () => {
  useClaimStore();
  // Owner start time stays null: the pinned test start time diverges from the real one the lock's
  // liveness probe reads, which would classify this held lock as PID-reused and let it be reclaimed.
  const release = await acquireProcessLock({
    lockDirPath: `${claimFilePath()}.lock`,
    owner: { pid: process.pid, startTime: null, acquiredAtMs: Date.now() },
    timeoutMs: 5_000,
    description: 'test-held device claim lock',
  });

  let callbackRan = false;
  const held = await withDeviceClaimLockHeld(deviceKey, process.env, async () => {
    callbackRan = true;
    return 'unused';
  });
  await release();

  expect(held).toEqual({ status: 'conflict' });
  expect(callbackRan).toBe(false);
  // The released lock is free again, so the same call runs.
  expect(await withDeviceClaimLockHeld(deviceKey, process.env, async () => 'ran')).toEqual({
    status: 'ran',
    result: 'ran',
  });
});
