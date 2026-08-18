import { expect, test } from 'vitest';
import { ANDROID_EMULATOR } from '../../__tests__/test-utils/device-fixtures.ts';
import {
  isolatedDeviceClaimStores,
  retainOrphanedDeviceClaims,
} from '../../__tests__/test-utils/device-claim-store.ts';
import fs from 'node:fs';
import { acquireDeviceClaim } from '../device-claims.ts';
import { resolveDeviceClaimPath } from '../device-claim-paths.ts';
import { inspectDeviceClaims } from '../device-claim-inspection.ts';
import { createDaemonShutdownClaimLedger } from './daemon-shutdown-claims.ts';
import type { SessionState } from '../types.ts';

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

  expect(ledger.claims).toEqual({ released: [], orphaned: [], superseded: [] });
});
