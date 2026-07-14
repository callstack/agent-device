import { test, expect, vi } from 'vitest';
import os from 'node:os';
import path from 'node:path';

let snapshotCalls = 0;
const dispatchCalls: string[][] = [];
let snapshotMode: 'blocking-dialog' | 'throws' = 'blocking-dialog';

vi.mock('../../core/dispatch.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../core/dispatch.ts')>();
  return {
    ...actual,
    dispatchCommand: vi.fn(async (_device: unknown, command: string, positionals: string[]) => {
      dispatchCalls.push([command, ...positionals]);
      return {};
    }),
  };
});

import { createRequestHandler } from '../request-router.ts';
import type { SessionState } from '../types.ts';
import { LeaseRegistry } from '../lease-registry.ts';
import { makeSessionStore } from '../../__tests__/test-utils/store-factory.ts';
import {
  createProviderDeviceRuntimeRequestProviders,
  type ProviderDeviceRuntime,
} from '../../provider-device-runtime.ts';

vi.mock('../../platforms/android/snapshot.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../platforms/android/snapshot.ts')>();
  return {
    ...actual,
    snapshotAndroid: vi.fn(async () => {
      snapshotCalls += 1;
      if (snapshotMode === 'throws') {
        throw new Error('Android snapshot helper did not return XML');
      }
      if (snapshotCalls === 1) {
        return {
          nodes: [
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
          ],
        };
      }
      return { nodes: [] };
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
  return {
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
    recording: {
      platform: 'android',
      outPath: '/tmp/demo.mp4',
      remotePath: '/sdcard/demo.mp4',
      remotePid: '4242',
      startedAt: Date.now() - 1_000,
      showTouches: true,
      gestureEvents: [],
    },
  };
}

test('generic Android gesture commands dismiss blocking system dialogs during recording', async () => {
  snapshotCalls = 0;
  snapshotMode = 'blocking-dialog';
  execCalls.length = 0;
  dispatchCalls.length = 0;

  const sessionStore = makeSessionStore('agent-device-router-android-modal-');
  sessionStore.set('default', makeAndroidSession('default'));

  const { openAndroidApp } = await import('../../platforms/android/app-lifecycle.ts');

  const handler = createRequestHandler({
    logPath: path.join(os.tmpdir(), 'daemon.log'),
    token: 'test-token',
    sessionStore,
    leaseRegistry: new LeaseRegistry(),
    trackDownloadableArtifact: () => 'artifact-id',
  });

  const response = await handler({
    token: 'test-token',
    session: 'default',
    command: 'scroll',
    positionals: ['down', '0.55'],
    meta: { requestId: 'req-android-modal' },
  });

  expect(response.ok).toBe(true);
  expect(dispatchCalls).toEqual([['scroll', 'down', '0.55']]);
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

  const sessionStore = makeSessionStore('agent-device-router-android-modal-');
  sessionStore.set('default', makeAndroidSession('default'));

  const { openAndroidApp } = await import('../../platforms/android/app-lifecycle.ts');
  vi.mocked(openAndroidApp).mockClear();

  const handler = createRequestHandler({
    logPath: path.join(os.tmpdir(), 'daemon.log'),
    token: 'test-token',
    sessionStore,
    leaseRegistry: new LeaseRegistry(),
    trackDownloadableArtifact: () => 'artifact-id',
  });

  const response = await handler({
    token: 'test-token',
    session: 'default',
    command: 'scroll',
    positionals: ['down', '0.55'],
    meta: { requestId: 'req-android-modal-inspection-failed' },
  });

  expect(response.ok).toBe(true);
  expect(dispatchCalls).toEqual([['scroll', 'down', '0.55']]);
  expect(execCalls).toEqual([]);
  expect(openAndroidApp).not.toHaveBeenCalled();
  expect(snapshotCalls).toBe(1);
});

test('generic Android gesture commands skip local dialog recovery for provider devices', async () => {
  snapshotCalls = 0;
  snapshotMode = 'blocking-dialog';
  execCalls.length = 0;
  dispatchCalls.length = 0;

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
    providerDeviceRuntimeScope: providers.providerDeviceRuntimeScope,
    trackDownloadableArtifact: () => 'artifact-id',
  });

  const response = await handler({
    token: 'test-token',
    session: 'default',
    command: 'scroll',
    positionals: ['down', '0.55'],
    meta: { requestId: 'req-android-modal-provider' },
  });

  expect(response.ok).toBe(true);
  expect(dispatchCalls).toEqual([['scroll', 'down', '0.55']]);
  expect(execCalls).toEqual([]);
  expect(snapshotCalls).toBe(0);
});
