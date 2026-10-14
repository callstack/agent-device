import { daemonPlatformServicesFixture } from '../../../../__tests__/support/platform-services-fixture.ts';
import { test, expect } from 'vitest';
import * as path from 'node:path';
import { buildSnapshotSignatures } from '@agent-device/capture-kit/snapshot-freshness';
import { AppError } from '@agent-device/kernel/errors';
import {
  mockLifecycleDispatch as mockDispatch,
  mockResolveTargetDevice,
  makeSessionStore,
  makeSession,
  noopInvoke,
  withMockedPlatform,
} from '../../../../__tests__/support/handlers/session-test-harness.ts';
import type { SessionState } from '../../../../core/session-state.ts';
import { handleSessionCommands } from '../../../../__tests__/support/handlers/session-command-harness.ts';
import { mkdtempForTestSync } from '@agent-device/test-kit/tmp-dir';
import { fakeCreateCommandSurface } from '../../../../__tests__/support/command-surface-fake.ts';

test('open on existing iOS session refreshes unavailable simulator by name', async () => {
  const sessionStore = makeSessionStore();
  const sessionName = 'ios-session';
  sessionStore.publish(sessionName, {
    ...makeSession(sessionName, {
      platform: 'apple',
      id: 'stale-sim',
      name: 'iPhone 17 Pro',
      kind: 'simulator',
      booted: false,
    }),
    appBundleId: 'com.example.old',
    appName: 'Old App',
  });

  const resolvedDevice: SessionState['device'] = {
    platform: 'apple',
    id: 'fresh-sim',
    name: 'iPhone 17 Pro',
    kind: 'simulator',
    booted: true,
  };
  const selectors: Array<Record<string, unknown>> = [];
  let dispatchedDeviceId: string | undefined;

  mockResolveTargetDevice.mockImplementation(async (selector) => {
    selectors.push({ ...selector });
    if ((selector as any).udid === 'stale-sim') {
      throw new AppError('DEVICE_NOT_FOUND', 'not found');
    }
    return resolvedDevice;
  });
  mockDispatch.mockImplementation(async (device) => {
    dispatchedDeviceId = device.id;
    return {};
  });

  const response = await withMockedPlatform('darwin', async () =>
    handleSessionCommands({
      createCommandSurface: fakeCreateCommandSurface,
      platformServices: daemonPlatformServicesFixture(),
      req: {
        token: 't',
        session: sessionName,
        command: 'open',
        positionals: ['settings'],
        flags: {},
      },
      sessionName,
      logPath: path.join(mkdtempForTestSync('daemon'), 'daemon.log'),
      sessionStore,
      invoke: noopInvoke,
    }),
  );

  expect(response).toBeTruthy();
  expect(response?.ok).toBe(true);
  expect(selectors.length).toBe(2);
  expect(selectors[0]).toEqual({ platform: 'ios', target: undefined, udid: 'stale-sim' });
  expect(selectors[1]).toEqual({ platform: 'ios', target: undefined, device: 'iPhone 17 Pro' });
  expect(dispatchedDeviceId).toBe('fresh-sim');
  const updated = sessionStore.get(sessionName);
  expect(updated?.device.id).toBe('fresh-sim');
  if (response && response.ok) {
    expect(response.data?.device_udid).toBe('fresh-sim');
  }
});

test('open on existing Android session preserves a comparable freshness baseline', async () => {
  const sessionStore = makeSessionStore();
  const sessionName = 'android-open-freshness';
  const baselineNodes = Array.from({ length: 14 }, (_, index) => ({
    ref: `e${index + 1}`,
    index,
    depth: 0,
    type: 'android.widget.TextView',
    label: `Inbox row ${index + 1}`,
  }));
  sessionStore.publish(sessionName, {
    ...makeSession(sessionName, {
      platform: 'android',
      id: 'emulator-5554',
      name: 'Pixel Emulator',
      kind: 'emulator',
      booted: true,
    }),
    appBundleId: 'com.example.old',
    appName: 'Old App',
    snapshot: {
      nodes: baselineNodes,
      createdAt: Date.now(),
      backend: 'android',
      comparisonSafe: true,
    },
  });

  mockDispatch.mockResolvedValue(undefined);

  const response = await handleSessionCommands({
    createCommandSurface: fakeCreateCommandSurface,
    platformServices: daemonPlatformServicesFixture(),
    req: {
      token: 't',
      session: sessionName,
      command: 'open',
      positionals: ['settings'],
      flags: {},
    },
    sessionName,
    logPath: path.join(mkdtempForTestSync('daemon'), 'daemon.log'),
    sessionStore,
    invoke: noopInvoke,
  });

  expect(response?.ok).toBe(true);
  const updated = sessionStore.get(sessionName);
  expect(updated?.snapshot).toBeUndefined();
  expect(updated?.androidSnapshotFreshness).toEqual({
    action: 'open',
    markedAt: expect.any(Number),
    baselineCount: baselineNodes.length,
    baselineSignatures: buildSnapshotSignatures(baselineNodes),
    routeComparable: true,
  });
});
