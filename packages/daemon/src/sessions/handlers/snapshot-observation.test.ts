import { beforeEach, expect, test, vi } from 'vitest';
import { forwardingCreateCommandSurface } from '../../__tests__/support/command-surface-fake.ts';
import { legacyDispatchCapture } from '../../__tests__/support/legacy-snapshot-capture-fixture.ts';
import { daemonPlatformServicesFixture } from '../../__tests__/support/platform-services-fixture.ts';
import {
  androidDevice,
  countingSnapshotRuntime,
  handleSnapshotCommands,
  makeSession,
  makeSessionStore,
  snapshotRequest,
} from '../../__tests__/support/handlers/snapshot-handler.fixtures.ts';

beforeEach(() => {
  legacyDispatchCapture.mockReset();
  legacyDispatchCapture.mockResolvedValue({
    backend: 'android',
    viewport: { width: 1080, height: 2400 },
    nodes: [
      {
        index: 0,
        depth: 0,
        type: 'android.widget.Button',
        label: '+ Add one',
        rect: { x: 400, y: 800, width: 300, height: 90 },
      },
    ],
  });
});

test('an admitted Android observation returns geometry without a session lookup or publication', async () => {
  const sessionStore = makeSessionStore();
  const lookup = vi.spyOn(sessionStore, 'lookup');
  const assertCurrent = vi.fn();
  const response = await handleSnapshotCommands({
    createCommandSurface: forwardingCreateCommandSurface,
    platformServices: daemonPlatformServicesFixture(),
    req: snapshotRequest('default', 'snapshot', {
      flags: { serial: androidDevice.id, snapshotObserveOnly: true },
      internal: { snapshotObservation: { device: androidDevice, assertCurrent } },
    }),
    sessionName: 'default',
    sessionStore,
    logPath: '/tmp/daemon.log',
  });

  expect(response?.ok).toBe(true);
  const data = response?.ok ? response.data : undefined;
  expect(data?.nodes).toEqual([
    expect.objectContaining({
      label: '+ Add one',
      rect: { x: 400, y: 800, width: 300, height: 90 },
    }),
  ]);
  expect(data?.nodes).toEqual([expect.not.objectContaining({ ref: expect.any(String) })]);
  expect(data?.refsGeneration).toBeUndefined();
  expect(lookup).not.toHaveBeenCalled();
  expect(sessionStore.listRefs()).toEqual([]);
  expect(assertCurrent).toHaveBeenCalled();
});

test('an admitted Android observation preserves the existing baseline, actions and ref generation', async () => {
  const sessionStore = makeSessionStore();
  const initial = makeSession('agent', androidDevice);
  const ref = sessionStore.publish('agent', initial);
  const params = {
    createCommandSurface: forwardingCreateCommandSurface,
    platformServices: daemonPlatformServicesFixture(),
    sessionName: 'agent',
    sessionStore,
    logPath: '/tmp/daemon.log',
  };
  await handleSnapshotCommands({ ...params, req: snapshotRequest('agent', 'snapshot') });
  const session = sessionStore.requireCurrent(ref);
  const snapshot = session.snapshot;
  const generation = session.snapshotGeneration;
  const actions = [...session.actions];
  legacyDispatchCapture.mockResolvedValue({ backend: 'android', nodes: [] });

  const response = await handleSnapshotCommands({
    ...params,
    req: snapshotRequest('agent', 'snapshot', {
      flags: { snapshotObserveOnly: true },
      internal: { snapshotObservation: { device: androidDevice, assertCurrent: () => {} } },
    }),
  });

  expect(response?.ok).toBe(true);
  expect(session.snapshot).toBe(snapshot);
  expect(session.snapshotGeneration).toBe(generation);
  expect(session.actions).toEqual(actions);
  expect(sessionStore.listRefs()).toHaveLength(1);
});

test('a revoked Android observation refuses before any device capture', async () => {
  const sessionStore = makeSessionStore();
  const revoked = new Error('observation lifetime revoked');
  const capture = handleSnapshotCommands({
    createCommandSurface: forwardingCreateCommandSurface,
    platformServices: daemonPlatformServicesFixture(),
    req: snapshotRequest('default', 'snapshot', {
      flags: { serial: androidDevice.id, snapshotObserveOnly: true },
      internal: {
        snapshotObservation: {
          device: androidDevice,
          assertCurrent: () => {
            throw revoked;
          },
        },
      },
    }),
    sessionName: 'default',
    sessionStore,
    logPath: '/tmp/daemon.log',
  });

  await expect(capture).rejects.toBe(revoked);
  expect(legacyDispatchCapture).not.toHaveBeenCalled();
  expect(sessionStore.listRefs()).toEqual([]);
});

test('Android observation refuses a result when its authority is revoked during capture', async () => {
  const sessionStore = makeSessionStore();
  let active = true;
  const revoked = new Error('observation authority ended during capture');
  legacyDispatchCapture.mockImplementation(async () => {
    active = false;
    return { backend: 'android', nodes: [] };
  });
  const capture = handleSnapshotCommands({
    createCommandSurface: forwardingCreateCommandSurface,
    platformServices: daemonPlatformServicesFixture(),
    req: snapshotRequest('default', 'snapshot', {
      flags: { serial: androidDevice.id, snapshotObserveOnly: true },
      internal: {
        snapshotObservation: {
          device: androidDevice,
          assertCurrent: () => {
            if (active === false) throw revoked;
          },
        },
      },
    }),
    sessionName: 'default',
    sessionStore,
    logPath: '/tmp/daemon.log',
  });

  await expect(capture).rejects.toBe(revoked);
  expect(legacyDispatchCapture).toHaveBeenCalledOnce();
  expect(sessionStore.listRefs()).toEqual([]);
});

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
