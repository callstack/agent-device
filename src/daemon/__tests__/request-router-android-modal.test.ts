import { createTestDeviceInventoryGateways } from '../../__tests__/test-utils/device-inventory-gateways.ts';
import { test, expect, vi } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import { AppError } from '@agent-device/kernel/errors';
import type { RawSnapshotNode } from '@agent-device/kernel/snapshot';

let snapshotCalls = 0;
const dispatchCalls: string[][] = [];
let snapshotMode: 'blocking-dialog' | 'throws' = 'blocking-dialog';
let dispatchResult: Record<string, unknown> = {};

vi.mock('../../core/dispatch.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../core/dispatch.ts')>();
  return {
    ...actual,
    dispatchCommand: vi.fn(async (_device: unknown, command: string, positionals: string[]) => {
      dispatchCalls.push([command, ...positionals]);
      return dispatchResult;
    }),
  };
});

import {
  createRequestHandler,
  gestureDeviceRuntimeGateway,
  gestureRuntimeSpies,
} from './test-device-runtime-gateway.ts';
import type { SessionState } from '../types.ts';
import { LeaseRegistry } from '../lease-registry.ts';
import { makeSessionStore } from '../../__tests__/test-utils/store-factory.ts';
import { createProviderDeviceRuntimeRequestProviders } from '../../provider-device-runtime.ts';
import type { ProviderDeviceRuntime } from '@agent-device/contracts/device';
import { makeTestScreenRecordingResource } from '../../__tests__/test-utils/screen-recording-live-handle.ts';

vi.mock('../../platforms/android/snapshot.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../platforms/android/snapshot.ts')>();
  const { createAndroidSnapshotCapture } =
    await import('../../platforms/android/snapshot-capture.ts');
  const capture = (nodes: RawSnapshotNode[]) =>
    createAndroidSnapshotCapture(
      {
        nodes,
        analysis: { rawNodeCount: nodes.length, maxDepth: 0 },
        androidSnapshot: { backend: 'android-helper' },
        quality: { state: 'healthy', backend: 'android-helper' },
      },
      {
        clickability: {
          kind: 'exact',
          provider: 'android-helper',
          clickableByNodeIndex: new Map(),
        },
      },
    );
  return {
    ...actual,
    snapshotAndroid: vi.fn(async () => {
      snapshotCalls += 1;
      if (snapshotMode === 'throws') {
        throw new AppError(
          'COMMAND_FAILED',
          'Android snapshot helper is unavailable: helper artifact is missing',
          { hint: 'Run `pnpm build:android` to build the Android snapshot helper.' },
        );
      }
      if (snapshotCalls === 1) {
        return capture([
          {
            index: 0,
            type: 'android.widget.TextView',
            label: 'Process system is not responding',
            rect: { x: 50, y: 400, width: 500, height: 80 },
          },
          {
            index: 1,
            type: 'android.widget.Button',
            label: 'Close app',
            rect: { x: 100, y: 600, width: 220, height: 80 },
          },
        ]);
      }
      return capture([]);
    }),
  };
});

vi.mock('../../platforms/android/app-lifecycle.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../platforms/android/app-lifecycle.ts')>();
  return {
    ...actual,
    openAndroidApp: vi.fn(async () => {}),
    getAndroidAppState: vi.fn(async () => ({ package: 'com.android.settings' })),
    getAndroidBlockingDialogFocus: vi.fn(async () => null),
  };
});

const execCalls: string[][] = [];

vi.mock('../../utils/exec.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../utils/exec.ts')>();
  return {
    ...actual,
    runCmd: vi.fn(async (_cmd: string, args: string[]) => {
      execCalls.push(args);
      return { stdout: '', stderr: '', exitCode: 0 };
    }),
  };
});

function makeAndroidSession(name: string): SessionState {
  const session: SessionState = {
    name,
    createdAt: Date.now(),
    appBundleId: 'com.android.settings',
    actions: [],
    device: {
      platform: 'android',
      target: 'mobile',
      id: 'emulator-5554',
      name: 'Pixel 9 Pro XL',
      kind: 'emulator',
      booted: true,
    },
  };
  session.screenRecording = makeTestScreenRecordingResource(session, {
    backend: 'adb screenrecord',
    outPath: '/tmp/demo.mp4',
    startedAt: Date.now() - 1_000,
    showTouches: true,
  });
  return session;
}

test('generic Android gesture commands dismiss blocking system dialogs during recording', async () => {
  snapshotCalls = 0;
  snapshotMode = 'blocking-dialog';
  dispatchResult = {};
  execCalls.length = 0;
  dispatchCalls.length = 0;
  gestureRuntimeSpies.scrollDirection.mockClear();

  const sessionStore = makeSessionStore('agent-device-router-android-modal-');
  sessionStore.set('default', makeAndroidSession('default'));

  const { openAndroidApp } = await import('../../platforms/android/app-lifecycle.ts');

  const handler = createRequestHandler({
    logPath: path.join(os.tmpdir(), 'daemon.log'),
    token: 'test-token',
    sessionStore,
    leaseRegistry: new LeaseRegistry(),
    deviceInventoryGateways: createTestDeviceInventoryGateways(),
    trackDownloadableArtifact: () => 'artifact-id',
    deviceRuntimeGateway: gestureDeviceRuntimeGateway,
  });

  const response = await handler({
    token: 'test-token',
    session: 'default',
    command: 'scroll',
    positionals: ['down', '0.55'],
    meta: { requestId: 'req-android-modal' },
  });

  expect(response.ok).toBe(true);
  // R43: `scroll` reaches the device through its bound operation, so the dispatcher sees nothing.
  expect(dispatchCalls).toEqual([]);
  expect(gestureRuntimeSpies.scrollDirection).toHaveBeenCalledTimes(1);
  expect(gestureRuntimeSpies.scrollDirection.mock.calls[0]?.[0]).toMatchObject({
    direction: 'down',
    options: { amount: 0.55 },
  });
  expect(execCalls).toEqual([['-s', 'emulator-5554', 'shell', 'input', 'tap', '210', '640']]);
  expect(openAndroidApp).toHaveBeenCalledWith(
    expect.objectContaining({ id: 'emulator-5554' }),
    'com.android.settings',
  );
  expect(snapshotCalls).toBe(2);
});

test('generic Android gesture commands continue when recording dialog inspection fails', async () => {
  snapshotCalls = 0;
  snapshotMode = 'throws';
  execCalls.length = 0;
  dispatchCalls.length = 0;
  gestureRuntimeSpies.scrollDirection.mockClear();
  // The owner's own result is what the readiness warning has to merge with, so the bound
  // operation carries it now that the dispatcher no longer executes this command.
  gestureRuntimeSpies.scrollDirection.mockResolvedValueOnce({
    warning: 'The platform response already carried a warning.',
  });

  const sessionStore = makeSessionStore('agent-device-router-android-modal-');
  sessionStore.set('default', makeAndroidSession('default'));

  const { openAndroidApp } = await import('../../platforms/android/app-lifecycle.ts');
  vi.mocked(openAndroidApp).mockClear();

  const handler = createRequestHandler({
    logPath: path.join(os.tmpdir(), 'daemon.log'),
    token: 'test-token',
    sessionStore,
    leaseRegistry: new LeaseRegistry(),
    deviceInventoryGateways: createTestDeviceInventoryGateways(),
    trackDownloadableArtifact: () => 'artifact-id',
    deviceRuntimeGateway: gestureDeviceRuntimeGateway,
  });

  const response = await handler({
    token: 'test-token',
    session: 'default',
    command: 'scroll',
    positionals: ['down', '0.55'],
    meta: { requestId: 'req-android-modal-inspection-failed' },
  });

  expect(response.ok).toBe(true);
  // R43: `scroll` reaches the device through its bound operation, so the dispatcher sees nothing.
  expect(dispatchCalls).toEqual([]);
  expect(gestureRuntimeSpies.scrollDirection).toHaveBeenCalledTimes(1);
  expect(gestureRuntimeSpies.scrollDirection.mock.calls[0]?.[0]).toMatchObject({
    direction: 'down',
    options: { amount: 0.55 },
  });
  expect(execCalls).toEqual([]);
  expect(openAndroidApp).not.toHaveBeenCalled();
  expect(snapshotCalls).toBe(1);
  if (response.ok) {
    expect(response.data?.warning).toMatch(
      /Android blocking-dialog readiness could not be inspected.*command continued/i,
    );
    expect(response.data?.warning).toContain('pnpm build:android');
    expect(response.data?.warning).toContain('The platform response already carried a warning.');
  }
});

test('generic Android gesture commands skip local dialog recovery for provider devices', async () => {
  snapshotCalls = 0;
  snapshotMode = 'blocking-dialog';
  dispatchResult = {};
  execCalls.length = 0;
  dispatchCalls.length = 0;
  gestureRuntimeSpies.scrollDirection.mockClear();

  const sessionStore = makeSessionStore('agent-device-router-android-modal-provider-');
  const session = makeAndroidSession('default');
  sessionStore.set('default', session);

  const runtime: ProviderDeviceRuntime = {
    provider: 'webdriver-fake',
    leaseLifecycle: {},
    deviceInventoryProvider: async () => [session.device],
    ownsDevice: (device) => device.id === session.device.id,
    getInteractor: () => undefined,
    shutdown: async () => {},
  };
  const providers = createProviderDeviceRuntimeRequestProviders([runtime]);

  const handler = createRequestHandler({
    logPath: path.join(os.tmpdir(), 'daemon.log'),
    token: 'test-token',
    sessionStore,
    leaseRegistry: new LeaseRegistry(),
    deviceInventoryGateways: createTestDeviceInventoryGateways(),
    providerDeviceRuntimeScope: providers.providerDeviceRuntimeScope,
    trackDownloadableArtifact: () => 'artifact-id',
    deviceRuntimeGateway: gestureDeviceRuntimeGateway,
  });

  const response = await handler({
    token: 'test-token',
    session: 'default',
    command: 'scroll',
    positionals: ['down', '0.55'],
    meta: { requestId: 'req-android-modal-provider' },
  });

  expect(response.ok).toBe(true);
  // R43: `scroll` reaches the device through its bound operation, so the dispatcher sees nothing.
  expect(dispatchCalls).toEqual([]);
  expect(gestureRuntimeSpies.scrollDirection).toHaveBeenCalledTimes(1);
  expect(gestureRuntimeSpies.scrollDirection.mock.calls[0]?.[0]).toMatchObject({
    direction: 'down',
    options: { amount: 0.55 },
  });
  expect(execCalls).toEqual([]);
  expect(snapshotCalls).toBe(0);
});
