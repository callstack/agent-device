import { beforeEach, expect, test } from 'vitest';
import { forwardingCreateCommandSurface } from '../../__tests__/support/command-surface-fake.ts';
import { legacyDispatchCapture } from '../../__tests__/support/legacy-snapshot-capture-fixture.ts';
import { daemonPlatformServicesFixture } from '../../__tests__/support/platform-services-fixture.ts';
import {
  androidDevice,
  countingSnapshotRuntime,
  handleSnapshotCommands,
  makeSessionStore,
  snapshotRequest,
} from '../../__tests__/support/handlers/snapshot-handler.fixtures.ts';

beforeEach(() => {
  legacyDispatchCapture.mockReset();
});

test.each(['before binding', 'during capture'])(
  'Android observation refuses authority revoked %s',
  async (when) => {
    const sessionStore = makeSessionStore();
    const runtime = countingSnapshotRuntime();
    const revoked = new Error('observation authority revoked');
    const revokedBeforeBinding = when === 'before binding';
    let active = !revokedBeforeBinding;
    legacyDispatchCapture.mockImplementation(async () => {
      active = false;
      return { backend: 'android', nodes: [] };
    });

    const capture = handleSnapshotCommands({
      createCommandSurface: forwardingCreateCommandSurface,
      platformServices: daemonPlatformServicesFixture(),
      inspectFacts: runtime.inspectFacts,
      bindDevice: runtime.bindDevice,
      req: snapshotRequest('default', 'snapshot', {
        flags: { serial: androidDevice.id, snapshotObserveOnly: true },
        internal: {
          snapshotObservation: {
            device: androidDevice,
            assertCurrent: () => {
              if (!active) throw revoked;
            },
          },
        },
      }),
      sessionName: 'default',
      sessionStore,
      logPath: '/tmp/daemon.log',
    });

    await expect(capture).rejects.toBe(revoked);
    expect(runtime.bindCount()).toBe(revokedBeforeBinding ? 0 : 1);
    expect(legacyDispatchCapture).toHaveBeenCalledTimes(revokedBeforeBinding ? 0 : 1);
    expect(sessionStore.listRefs()).toEqual([]);
  },
);

test('Android observation refuses provider-owned capture before binding or acquiring a helper', async () => {
  const sessionStore = makeSessionStore();
  const runtime = countingSnapshotRuntime();
  const localFacts = await runtime.inspectFacts(androidDevice);
  const providerFacts = {
    ...localFacts,
    device: { ...localFacts.device, providerMode: 'provider-runtime' as const },
  };
  const capture = handleSnapshotCommands({
    createCommandSurface: forwardingCreateCommandSurface,
    platformServices: daemonPlatformServicesFixture(),
    inspectFacts: async () => providerFacts,
    bindDevice: runtime.bindDevice,
    req: snapshotRequest('default', 'snapshot', {
      flags: { serial: androidDevice.id, snapshotObserveOnly: true },
      internal: {
        snapshotObservation: { device: androidDevice, assertCurrent: () => {} },
      },
    }),
    sessionName: 'default',
    sessionStore,
    logPath: '/tmp/daemon.log',
  });

  await expect(capture).rejects.toMatchObject({
    code: 'UNSUPPORTED_OPERATION',
    details: { reason: 'android_observe_only_adb_required' },
  });
  expect(runtime.bindCount()).toBe(0);
  expect(legacyDispatchCapture).not.toHaveBeenCalled();
});
