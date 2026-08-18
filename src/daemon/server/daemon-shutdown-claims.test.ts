import { expect, test } from 'vitest';
import { ANDROID_EMULATOR } from '../../__tests__/test-utils/device-fixtures.ts';
import {
  isolatedDeviceClaimStores,
  retainOrphanedDeviceClaims,
} from '../../__tests__/test-utils/device-claim-store.ts';
import { acquireDeviceClaim } from '../device-claims.ts';
import { inspectDeviceClaims } from '../device-claim-inspection.ts';
import { createDaemonShutdownClaimLedger } from './daemon-shutdown-claims.ts';
import type { SessionState } from '../types.ts';

const setup = isolatedDeviceClaimStores('agent-device-shutdown-claim-ledger-');

async function claimedSession(name: string): Promise<SessionState> {
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
    released: [
      {
        deviceKey: session.deviceClaim?.deviceKey,
        session: 'default',
        platform: 'android',
        deviceId: 'emulator-5554',
      },
    ],
    orphaned: [],
  });
  expect(inspectDeviceClaims({})).toEqual([]);
});

test('a claim left behind by a failed teardown is reported orphaned', async () => {
  const session = await claimedSession('stuck');
  const ledger = createDaemonShutdownClaimLedger();

  // Teardown never reached a safe terminal state, so `releaseClaim` never runs.
  ledger.finalize(session);

  expect(ledger.claims.released).toEqual([]);
  expect(ledger.claims.orphaned).toEqual([
    {
      deviceKey: session.deviceClaim?.deviceKey,
      session: 'stuck',
      platform: 'android',
      deviceId: 'emulator-5554',
    },
  ]);
  expect(inspectDeviceClaims({}).map((entry) => entry.claim?.session)).toEqual(['stuck']);
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

  expect(ledger.claims).toEqual({ released: [], orphaned: [] });
});
