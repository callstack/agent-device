import { test, expect, vi, beforeEach } from 'vitest';
import * as path from 'node:path';
import { LeaseRegistry } from '../../../daemon/lease-registry.ts';
import { fakeCreateCommandSurface } from '../../../daemon/__tests__/support/command-surface-fake.ts';
import { createTestDeviceInventoryGateways } from '@agent-device/device-selection/inventory-gateways-fixtures';
import { makeSessionStore } from '../../../daemon/__tests__/support/store-factory.ts';
import { makeSession } from '../../../daemon/__tests__/support/session-factories.ts';
import { getResolveTargetDeviceMock } from '../../../daemon/__tests__/request-router-dispatch-mocks.ts';
import type { DaemonRequest } from '../../../daemon/daemon-request.ts';
import { platformResourceCleanup } from '../../../platform-runtime-resource-cleanup.ts';

// The runner-retention decision is the real `PlatformResourceCleanup` rule (a booted simulator
// keeps its runner host across a plain close), so these close-policy cases run the composed
// cleanup, the way the daemon-composition lane composes it.

vi.mock('node:timers/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:timers/promises')>();
  return { ...actual, setTimeout: vi.fn(async () => undefined) };
});
vi.mock('../../../daemon/device/device-ready.ts', () => ({
  ensureDeviceReady: vi.fn(async () => {}),
}));
vi.mock('@agent-device/platform-apple/runner/operations', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('@agent-device/platform-apple/runner/operations')>();
  return {
    ...actual,
    prepareIosRunner: vi.fn(async () => ({
      runner: { currentUptimeMs: 42 },
      connectMs: 3,
      healthCheckMs: 3,
    })),
    prewarmIosRunnerSession: vi.fn(),
    notifyIosRunnerAppRelaunched: vi.fn(async () => {}),
    hasLiveIosRunnerSession: vi.fn(() => true),
    stopIosRunnerSession: vi.fn(async () => {}),
    releaseIosRunnerOnClose: vi.fn(async () => {}),
  };
});
vi.mock('@agent-device/platform-apple/app-resolution', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('@agent-device/platform-apple/app-resolution')>();
  return {
    ...actual,
    resolveIosApp: vi.fn(async (_device, app: string) => app),
    resolveIosSimulatorDeepLinkBundleId: vi.fn(async () => undefined),
  };
});
vi.mock('@agent-device/platform-android/mechanics', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@agent-device/platform-android/mechanics')>();
  return { ...actual, resolveAndroidPackageForOpen: vi.fn(async () => undefined) };
});

import { createRequestHandler } from '../../../daemon/__tests__/test-device-runtime-gateway.ts';
import { realLifecycleDeviceRuntimeGateway } from '../lifecycle-runtime-gateway.ts';
import {
  dispatchApplicationLifecycleEffect,
  awaitFixtureReadiness,
  discoverReadyAndroidEmulators,
} from '../application-lifecycle-runtime-fixture.ts';
import {
  stopIosRunnerSession,
  releaseIosRunnerOnClose,
} from '@agent-device/platform-apple/runner/operations';
import { mkdtempForTestSync } from '@agent-device/test-kit/tmp-dir';

const mockDispatch = vi.mocked(dispatchApplicationLifecycleEffect);
const mockAwaitFixtureReadiness = vi.mocked(awaitFixtureReadiness);
const mockDiscoverReadyAndroidEmulators = vi.mocked(discoverReadyAndroidEmulators);
const mockStopIosRunner = vi.mocked(stopIosRunnerSession);
const mockReleaseRunnerOnClose = vi.mocked(releaseIosRunnerOnClose);

beforeEach(() => {
  vi.useRealTimers();
  vi.mocked(getResolveTargetDeviceMock()).mockReset();
  mockDispatch.mockReset();
  mockDispatch.mockResolvedValue(undefined);
  mockAwaitFixtureReadiness.mockReset();
  mockAwaitFixtureReadiness.mockResolvedValue(undefined);
  mockDiscoverReadyAndroidEmulators.mockReset();
  mockDiscoverReadyAndroidEmulators.mockImplementation(async (device) => [
    {
      ...device,
      id: device.id.startsWith('emulator-') ? device.id : `emulator-${device.id}`,
      booted: true,
    },
  ]);
  mockStopIosRunner.mockReset();
  mockStopIosRunner.mockResolvedValue(undefined);
  mockReleaseRunnerOnClose.mockReset();
});

function createHandler(sessionStore: ReturnType<typeof makeSessionStore>) {
  return createRequestHandler({
    createCommandSurface: fakeCreateCommandSurface,
    logPath: path.join(mkdtempForTestSync('daemon'), 'daemon.log'),
    token: 'test-token',
    sessionStore,
    leaseRegistry: new LeaseRegistry(),
    deviceRuntimeGateway: realLifecycleDeviceRuntimeGateway,
    deviceInventoryGateways: createTestDeviceInventoryGateways(),
    platformResourceCleanup,
    trackDownloadableArtifact: () => 'artifact-id',
  });
}

let requestSeq = 0;

function sessionRequest(
  session: string,
  command: 'close',
  options: {
    positionals?: string[];
    flags?: Record<string, unknown>;
  } = {},
): DaemonRequest {
  requestSeq += 1;
  return {
    token: 'test-token',
    session,
    command,
    positionals: options.positionals ?? [],
    flags: options.flags ?? {},
    meta: { requestId: `req-close-retention-${requestSeq}` },
  };
}

test('close on iOS simulator session retains runner and deletes the session', async () => {
  const sessionStore = makeSessionStore('agent-device-close-retention-');
  const sessionName = 'ios-simulator-session';
  sessionStore.publish(
    sessionName,
    makeSession(sessionName, {
      device: {
        platform: 'apple',
        id: 'sim-1',
        name: 'iPhone 17 Pro',
        kind: 'simulator',
        booted: true,
      },
      appName: 'com.example.app',
    }),
  );

  const response = await createHandler(sessionStore)(sessionRequest(sessionName, 'close'));

  expect(response.ok).toBe(true);
  expect(mockStopIosRunner).not.toHaveBeenCalled();
  expect(mockReleaseRunnerOnClose).toHaveBeenCalledWith('sim-1', { retain: true });
  expect(sessionStore.get(sessionName)).toBeUndefined();
});

test('close on iOS simulator with scoped simulator set retains runner and deletes the session', async () => {
  const sessionStore = makeSessionStore('agent-device-close-retention-');
  const sessionName = 'ios-scoped-simulator-session';
  sessionStore.publish(
    sessionName,
    makeSession(sessionName, {
      device: {
        platform: 'apple',
        id: 'sim-1',
        name: 'iPhone 17 Pro',
        kind: 'simulator',
        booted: true,
        simulatorSetPath: '/tmp/tenant-a/simulator-set',
      },
      appName: 'com.example.app',
    }),
  );

  const response = await createHandler(sessionStore)(sessionRequest(sessionName, 'close'));

  expect(response.ok).toBe(true);
  expect(mockReleaseRunnerOnClose).toHaveBeenCalledWith('sim-1', { retain: true });
  expect(sessionStore.get(sessionName)).toBeUndefined();
});

test('close <app> on iOS simulator retains runner while terminating app', async () => {
  const sessionStore = makeSessionStore('agent-device-close-retention-');
  const sessionName = 'ios-simulator-close-session';
  sessionStore.publish(
    sessionName,
    makeSession(sessionName, {
      device: {
        platform: 'apple',
        id: 'sim-1',
        name: 'iPhone 17 Pro',
        kind: 'simulator',
        booted: true,
      },
      appName: 'com.example.app',
    }),
  );

  const calls: string[] = [];
  mockStopIosRunner.mockImplementation(async () => {
    calls.push('stop-runner');
  });
  mockReleaseRunnerOnClose.mockImplementation(async (_deviceId, options) => {
    calls.push(`release-runner:${options.retain ? 'retain' : 'stop'}`);
  });
  mockDispatch.mockImplementation(async (_device, command, positionals) => {
    calls.push(`${command}:${(positionals ?? []).join(' ')}`);
    return {};
  });

  const response = await createHandler(sessionStore)(
    sessionRequest(sessionName, 'close', { positionals: ['com.example.app'] }),
  );

  expect(response.ok).toBe(true);
  expect(calls).toEqual(['close:com.example.app', 'release-runner:retain']);
});
