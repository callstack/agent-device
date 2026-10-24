import { expect, test, vi } from 'vitest';
import { applicationLifecycleOperationFacts } from '@agent-device/contracts/application-lifecycle-runtime';
import { PendingTransferGuard } from '@agent-device/contracts/async-lifecycle';
import {
  type DeviceBinding,
  type DeviceRuntimeGateway,
  localRuntimeOwner,
} from '@agent-device/contracts/platform-runtime';
import type { PlatformRuntimeOperations } from '@agent-device/contracts/platform-runtime-operations';
import type { ScreenRecordingLiveHandle } from '@agent-device/contracts/screen-recording-runtime';
import { createDurableResourceEnvelope } from '@agent-device/capture-kit';
import type { DeviceInfo } from '@agent-device/kernel/device';
import { createTestDeviceInventoryGateways } from '@agent-device/device-selection/inventory-gateways-fixtures';
import {
  unavailableDeploymentSnapshotAndShutdownOperationFacts,
  createTestHostEnvironment,
} from '@agent-device/test-kit';
import { makeSessionStore } from '../../__tests__/support/store-factory.ts';
import { LeaseRegistry } from '../../resources/lease-registry.ts';
import { createRequestHandler } from '../../__tests__/support/test-device-runtime-gateway.ts';
import { fakeCreateCommandSurface as testCreateCommandSurface } from '../../__tests__/support/command-surface-fake.ts';

const DEVICE: DeviceInfo = {
  platform: 'android',
  id: 'emulator-5554',
  name: 'Pixel',
  kind: 'emulator',
};

vi.mock('@agent-device/device-selection/dispatch-resolve', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('@agent-device/device-selection/dispatch-resolve')>();
  return { ...actual, resolveTargetDevice: vi.fn(async () => DEVICE) };
});

vi.mock('../../core/device/device-ready.ts', () => ({
  ensureDeviceReady: vi.fn(async () => {}),
}));

test('fresh default-device recording starts serialize before durable admission', async () => {
  let releaseFirstStart: () => void = () => {};
  const firstStartBlocked = new Promise<void>((resolve) => {
    releaseFirstStart = resolve;
  });
  const runtime = makeRecordingGateway(firstStartBlocked);
  const sessionStore = makeSessionStore('request-router-record-runtime-lock-');
  const handler = createRequestHandler({
    host: createTestHostEnvironment(),
    createCommandSurface: testCreateCommandSurface,
    logPath: '/tmp/daemon.log',
    token: 'token',
    sessionStore,
    leaseRegistry: new LeaseRegistry(),
    deviceInventoryGateways: createTestDeviceInventoryGateways(),
    deviceRuntimeGateway: runtime.gateway,
    trackDownloadableArtifact: () => 'artifact',
  });

  const first = handler(recordStartRequest('session-a', 'record-start-a'));
  await vi.waitFor(() => expect(runtime.start).toHaveBeenCalledOnce());

  const second = handler(recordStartRequest('session-b', 'record-start-b'));
  await new Promise((resolve) => setTimeout(resolve, 20));
  expect(runtime.bind).toHaveBeenCalledOnce();
  expect(runtime.start).toHaveBeenCalledOnce();

  releaseFirstStart();
  await expect(first).resolves.toMatchObject({ ok: true, data: { recording: 'started' } });
  await expect(second).resolves.toMatchObject({
    ok: false,
    error: { code: 'COMMAND_FAILED', details: { reason: 'cleanup-unconfirmed' } },
  });
  expect(runtime.start).toHaveBeenCalledOnce();
});

function recordStartRequest(session: string, requestId: string) {
  return {
    token: 'token',
    session,
    command: 'record',
    positionals: ['start', `/tmp/${session}.mp4`],
    flags: { recordingScope: 'device' as const },
    meta: { requestId },
  };
}

function makeRecordingGateway(firstStartBlocked: Promise<void>) {
  const owner = localRuntimeOwner('android');
  let startCount = 0;
  const start = vi.fn(
    async (input: Parameters<PlatformRuntimeOperations['screenRecordingStart']>[0]) => {
      startCount += 1;
      if (startCount === 1) await firstStartBlocked;
      const handle = recordingHandle(input.outputPath);
      return {
        pendingHandle: new PendingTransferGuard(handle),
        envelope: createDurableResourceEnvelope({
          resourceKind: 'screen-recording',
          sessionId: input.sessionId,
          device: { id: DEVICE.id, family: 'android', kind: 'emulator' },
          owner,
          fence: input.fence,
          lifecycle: 'open',
          descriptor: { version: 1, body: { recordingId: input.sessionId } },
        }),
      };
    },
  );
  const bind = vi.fn(async (): Promise<DeviceBinding<PlatformRuntimeOperations>> => ({
    device: DEVICE,
    owner,
    facts: {
      device: { family: 'android', kind: 'emulator', providerMode: 'local' },
      operations: {
        appLogInspect: unavailable,
        appLogDoctor: unavailable,
        appLogStart: unavailable,
        appLogReattach: unavailable,
        appLogCleanup: unavailable,
        appState: unavailable,
        networkDump: unavailable,
        networkCaptureStart: unavailable,
        networkCaptureStop: unavailable,
        screenRecordingStart: { available: true },
        screenRecordingReattach: { available: true },
        screenRecordingCleanup: { available: true },
        ensureReady: unavailable,
        bootTarget: unavailable,
        bootTargetHeadless: unavailable,
        listApps: unavailable,
        ...unavailableDeploymentSnapshotAndShutdownOperationFacts,
        ...applicationLifecycleOperationFacts({
          resolveOpenTarget: unavailable,
          prepareApplicationOpen: unavailable,
          openApplication: unavailable,
          applyRuntimeHints: unavailable,
          clearRuntimeHints: unavailable,
          closeApplication: unavailable,
          finalizeApplicationClose: unavailable,
          prepareAppleRunner: unavailable,
          configureProviderPortReverse: unavailable,
        }),
      },
    },
    operations: {
      screenRecordingStart: start,
      screenRecordingReattach: async () => ({ status: 'missing' }),
      screenRecordingCleanup: async () => ({ status: 'already-missing' }),
    },
    [Symbol.asyncDispose]: async () => {},
  }));
  const gateway: DeviceRuntimeGateway<PlatformRuntimeOperations> = {
    inspectFacts: async () => {
      throw new Error('unused');
    },
    bind,
    shutdown: async () => {},
  };
  return { gateway, bind, start };
}

function recordingHandle(outPath: string): ScreenRecordingLiveHandle {
  return {
    inspect: () => ({
      backend: 'adb screenrecord',
      outPath,
      startedAt: 1,
      scope: 'device',
      showTouches: true,
      recordOnlySession: true,
      gestureEvents: [],
    }),
    appendGestureEvents: () => {},
    setTouchReferenceFrame: () => {},
    setRunnerSessionId: () => {},
    invalidate: () => {},
    finish: async () => ({
      status: 'completed',
      result: {
        backend: 'adb screenrecord',
        outPath,
        startedAt: 1,
        completedAt: 2,
        scope: 'device',
        showTouches: true,
        recordOnlySession: true,
      },
    }),
    forceCleanup: async () => ({ status: 'cleaned' }),
    [Symbol.asyncDispose]: async () => {},
  };
}

const unavailable = Object.freeze({
  available: false as const,
  reason: 'owner-capability-missing' as const,
});
