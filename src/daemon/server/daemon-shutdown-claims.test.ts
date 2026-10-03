import { afterEach, expect, test, vi } from 'vitest';
import { ANDROID_EMULATOR } from '../../__tests__/test-utils/device-fixtures.ts';
import {
  isolatedDeviceClaimStores,
  retainOrphanedDeviceClaims,
} from '../../__tests__/test-utils/device-claim-store.ts';
import fs from 'node:fs';
import { acquireDeviceClaim } from '../device/device-claims.ts';
import { acquireAllocatorHeldDeviceClaim } from '../device/device-claim-allocator.ts';
import { resolveDeviceClaimPath } from '../device/device-claim-paths.ts';
import { inspectDeviceClaims } from '../device/device-claim-inspection.ts';
import { createDaemonShutdownClaimLedger } from './daemon-shutdown-claims.ts';
import type { SessionState } from '../session-state.ts';

afterEach(() => {
  vi.restoreAllMocks();
});

const setup = isolatedDeviceClaimStores('agent-device-shutdown-claim-ledger-');

function claimRecord(session: SessionState, name: string) {
  return {
    deviceKey: session.deviceClaim?.deviceKey,
    session: name,
    platform: 'android',
    deviceId: 'emulator-5554',
  };
}

async function claimedSession(name: string): Promise<SessionState & { stateDir: string }> {
  const { stateDir } = setup();
  const acquired = await acquireDeviceClaim({
    device: ANDROID_EMULATOR,
    session: name,
    workspace: stateDir,
    stateDir,
    reconcileOrphanedDeviceClaim: retainOrphanedDeviceClaims,
  });
  if (acquired.status !== 'acquired') throw new Error('expected an acquired claim');
  return {
    stateDir,
    name,
    device: ANDROID_EMULATOR,
    deviceClaim: acquired.ownership,
    createdAt: Date.now(),
    actions: [],
  };
}

test('a claim cleared after clean teardown is reported released', async () => {
  const session = await claimedSession('default');
  const ledger = createDaemonShutdownClaimLedger();

  await ledger.releaseClaim(session);
  ledger.finalize(session);

  expect(ledger.claims).toEqual({
    released: [claimRecord(session, 'default')],
    orphaned: [],
    superseded: [],
    unattributable: [],
  });
  expect(inspectDeviceClaims({})).toEqual([]);
});

test('a claim left behind by a failed teardown is reported orphaned', async () => {
  const session = await claimedSession('stuck');
  const ledger = createDaemonShutdownClaimLedger();

  // Teardown never reached a safe terminal state, so `releaseClaim` never runs.
  ledger.finalize(session);

  expect(ledger.claims.released).toEqual([]);
  expect(ledger.claims.orphaned).toEqual([claimRecord(session, 'stuck')]);
  expect(inspectDeviceClaims({}).map((entry) => entry.claim?.session)).toEqual(['stuck']);
});

test('a claim replaced by a successor owner is reported superseded, never released', async () => {
  const session = await claimedSession('replaced');
  const deviceKey = session.deviceClaim?.deviceKey ?? '';
  // The shape recovery leaves behind: this daemon's claim file is removed out
  // from under it, and another owner claims the same device before this daemon
  // reaches teardown. `clearDeviceClaim` finds a claim it does not own and
  // deliberately leaves it alone, so "the call resolved" cannot mean "released".
  fs.rmSync(resolveDeviceClaimPath(deviceKey));
  const successor = await acquireDeviceClaim({
    device: ANDROID_EMULATOR,
    session: 'successor',
    workspace: '/worktrees/successor',
    stateDir: `${session.stateDir}-successor`,
    reconcileOrphanedDeviceClaim: retainOrphanedDeviceClaims,
  });
  expect(successor.status).toBe('acquired');

  const ledger = createDaemonShutdownClaimLedger();
  await ledger.releaseClaim(session);
  ledger.finalize(session);

  expect(ledger.claims.released).toEqual([]);
  expect(ledger.claims.orphaned).toEqual([]);
  expect(ledger.claims.superseded).toEqual([claimRecord(session, 'replaced')]);
  // The successor keeps its device: teardown must never delete a foreign claim.
  expect(inspectDeviceClaims({}).map((entry) => entry.claim?.session)).toEqual(['successor']);
});

test('an undecodable record is reported unattributable, never orphaned or superseded', async () => {
  const session = await claimedSession('unreadable');
  const deviceKey = session.deviceClaim?.deviceKey ?? '';
  // The record this daemon's claim points at can no longer be decoded into a process-owned claim.
  // That is neither fact at once: nothing proves a successor took the device, so it is not
  // `superseded`; and it is not `orphaned` either, because that bucket's remedy is
  // `device release --stale`, which proves staleness from the recorded owner this record does not
  // have. Claiming the bucket would send the operator to a command that refuses this record.
  fs.writeFileSync(resolveDeviceClaimPath(deviceKey), '{bad json');

  const ledger = createDaemonShutdownClaimLedger();
  await ledger.releaseClaim(session);
  ledger.finalize(session);

  expect(ledger.claims).toEqual({
    released: [],
    orphaned: [],
    superseded: [],
    unattributable: [claimRecord(session, 'unreadable')],
  });
});

test('an allocator-held record is reported unattributable, not released', async () => {
  const session = await claimedSession('allocator');
  const deviceKey = session.deviceClaim?.deviceKey ?? '';
  // A record owned by an allocator principal is attributable to that installation, but not to any
  // process this daemon's teardown can prove dead, and only the allocator's own removal proof clears
  // it. So this daemon released nothing and cannot reconcile the record either.
  fs.rmSync(resolveDeviceClaimPath(deviceKey));
  const held = await acquireAllocatorHeldDeviceClaim({
    device: ANDROID_EMULATOR,
    principal: {
      stateDir: '/installations/allocator',
      instanceId: 'allocator-1',
      identityIncarnationId: 'incarnation-1',
    },
  });
  expect(held.status).toBe('acquired');

  const ledger = createDaemonShutdownClaimLedger();
  await ledger.releaseClaim(session);
  ledger.finalize(session);

  expect(ledger.claims).toEqual({
    released: [],
    orphaned: [],
    superseded: [],
    unattributable: [claimRecord(session, 'allocator')],
  });
  // The allocator's grant survives a daemon that cannot settle it.
  expect(inspectDeviceClaims({}).map((entry) => entry.classification)).toEqual(['allocator-held']);
});

test('a claim clear that throws is reported orphaned, the one bucket with a working remedy', async () => {
  const session = await claimedSession('unrecorded');
  const ledger = createDaemonShutdownClaimLedger();
  // The clear never returned a verdict at all. This is the state the `orphaned` advice is written
  // for: our own owner identity dies with the exiting daemon, which is exactly the proof
  // `device release --stale` needs, and the record still names us.
  const unlink = vi.spyOn(fs, 'unlinkSync').mockImplementation(() => {
    throw Object.assign(new Error('EACCES'), { code: 'EACCES' });
  });

  await ledger.releaseClaim(session);
  unlink.mockRestore();
  ledger.finalize(session);

  expect(ledger.claims).toEqual({
    released: [],
    orphaned: [claimRecord(session, 'unrecorded')],
    superseded: [],
    unattributable: [],
  });
});

test('a session that never held a claim contributes nothing', async () => {
  const ledger = createDaemonShutdownClaimLedger();
  const session: SessionState = {
    name: 'remote',
    device: ANDROID_EMULATOR,
    createdAt: Date.now(),
    actions: [],
  };

  await ledger.releaseClaim(session);
  ledger.finalize(session);

  expect(ledger.claims).toEqual({
    released: [],
    orphaned: [],
    superseded: [],
    unattributable: [],
  });
});
