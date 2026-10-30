import assert from 'node:assert/strict';
import fs from 'node:fs';
import { afterEach, test, vi } from 'vitest';
import { AppError } from '@agent-device/kernel/errors';
import { withRunnerLeaseLock } from '../runner-lease.ts';
import { mkdtempForTestSync } from './tmp-dir.ts';

// A release that cannot read far enough to prove ownership leaves the lock standing and
// says so. That verdict is worth reporting when the task succeeded, and worth suppressing
// when the task already failed: the lock's own stale-clear path resolves a lock that is
// still standing, while nothing else recovers the reason the task failed.

const DEVICE_ID = 'release-ownership-runner';

let leaseRoot = '';

afterEach(() => {
  vi.restoreAllMocks();
  delete process.env.AGENT_DEVICE_IOS_RUNNER_LEASE_DIR;
  fs.rmSync(leaseRoot, { recursive: true, force: true });
});

function armUnverifiableRelease(root: string): () => void {
  const originalReadFileSync = fs.readFileSync;
  let armed = false;
  vi.spyOn(fs, 'readFileSync').mockImplementation(((
    ...args: Parameters<typeof fs.readFileSync>
  ) => {
    const target = args[0];
    if (
      armed &&
      typeof target === 'string' &&
      target.startsWith(root) &&
      target.endsWith('owner.json')
    ) {
      throw Object.assign(new Error('injected owner record i/o'), { code: 'EIO' });
    }
    return Reflect.apply(originalReadFileSync, fs, args);
  }) as typeof fs.readFileSync);
  return () => {
    armed = true;
  };
}

function beginLeaseRoot(): string {
  leaseRoot = mkdtempForTestSync('agent-device-lease-release-ownership-');
  process.env.AGENT_DEVICE_IOS_RUNNER_LEASE_DIR = leaseRoot;
  return leaseRoot;
}

test('a failed lease task outranks an unverifiable release', async () => {
  const root = beginLeaseRoot();
  const arm = armUnverifiableRelease(root);
  const taskFailure = new Error('the lease task failed');

  await assert.rejects(
    () =>
      withRunnerLeaseLock(DEVICE_ID, async () => {
        arm();
        throw taskFailure;
      }),
    (error: unknown) => {
      assert.equal(error, taskFailure);
      return true;
    },
  );
});

test('a lease lock that cannot be verified at release is reported and left standing', async () => {
  const root = beginLeaseRoot();
  const arm = armUnverifiableRelease(root);

  await assert.rejects(
    () =>
      withRunnerLeaseLock(DEVICE_ID, async () => {
        arm();
        return 'done';
      }),
    (error: unknown) => {
      assert.ok(error instanceof AppError);
      assert.equal(error.details?.ownerReleaseUnverified, true);
      return true;
    },
  );

  assert.deepEqual(fs.readdirSync(root), [`${DEVICE_ID}.json.lock`]);
});
