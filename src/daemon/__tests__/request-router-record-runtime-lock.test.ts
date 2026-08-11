import { expect, test, vi } from 'vitest';
import {
  localRuntimeOwner,
  PendingTransferGuard,
  type DeviceBinding,
  type DeviceRuntimeGateway,
  type PlatformRuntimeOperations,
  type ScreenRecordingLiveHandle,
} from '@agent-device/contracts/platform';
import { createDurableResourceEnvelope } from '@agent-device/capture-kit';
import type { DeviceInfo } from '@agent-device/kernel/device';
import { createTestDeviceInventoryGateways } from '../../__tests__/test-utils/device-inventory-gateways.ts';
import { makeSessionStore } from '../../__tests__/test-utils/store-factory.ts';
import { mkdtempForTestSync } from '../../__tests__/test-utils/tmp-dir.ts';
import { LeaseRegistry } from '../lease-registry.ts';
import { createPlatformRuntimeGateway } from '../../platform-runtime.ts';
import { createRequestHandler } from './test-device-runtime-gateway.ts';

const DEVICE: DeviceInfo = {
  platform: 'android',
  id: 'emulator-5554',
  name: 'Pixel',
  kind: 'emulator',
};

vi.mock('../../core/dispatch.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../core/dispatch.ts')>();
  return { ...actual, resolveTargetDevice: vi.fn(async () => DEVICE) };
});

vi.mock('../device-ready.ts', () => ({ ensureDeviceReady: vi.fn(async () => {}) }));

test('fresh default-device recording starts serialize before durable admission', async () => {
  let releaseFirstStart: () => void = () => {};
  const firstStartBlocked = new Promise<void>((resolve) => {
    releaseFirstStart = resolve;
  });
  const runtime = makeRecordingGateway(firstStartBlocked);
  const sessionStore = makeSessionStore('request-router-record-runtime-lock-');
  const handler = createRequestHandler({
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

test.each([
  { platform: 'linux', id: 'linux', name: 'Linux', kind: 'device', target: 'desktop' },
  { platform: 'vega', id: 'vega', name: 'Vega', kind: 'device', target: 'tv' },
] satisfies readonly DeviceInfo[])(
  'record start on $platform routes real unavailable runtime facts into public guidance',
  async (device) => {
    const sessionName = `record-${device.platform}-unsupported`;
    const sessionStore = makeSessionStore(`request-router-record-${device.platform}-unsupported-`);
    sessionStore.set(sessionName, {
      name: sessionName,
      device,
      createdAt: 1,
      actions: [],
    });
    const sessionsDir = mkdtempForTestSync(`record-${device.platform}-runtime-host-`);
    const gateway = createPlatformRuntimeGateway({
      sessionsDir,
      resolveSessionArtifacts: (candidate) => ({
        outputPath: `${sessionsDir}/${candidate}/app.log`,
        pidPath: `${sessionsDir}/${candidate}/app-log.pid`,
      }),
    });
    const bind = vi.fn(async (request) => await gateway.bind(request));
    const handler = createRequestHandler({
      logPath: '/tmp/daemon.log',
      token: 'token',
      sessionStore,
      leaseRegistry: new LeaseRegistry(),
      deviceInventoryGateways: createTestDeviceInventoryGateways(),
      deviceRuntimeGateway: { bind, shutdown: gateway.shutdown },
      trackDownloadableArtifact: () => 'artifact',
    });

    const response = await handler(recordStartRequest(sessionName, `record-${device.platform}`));

    expect(response).toMatchObject({
      ok: false,
      error: {
        code: 'UNSUPPORTED_OPERATION',
        message: 'record is not supported on this device',
        hint: 'Select an Apple, Android, physical HarmonyOS, or web target that supports screen recording.',
        details: { reason: 'unsupported-platform-leaf' },
      },
    });
    expect(bind).toHaveBeenCalledOnce();
    await gateway.shutdown();
  },
);

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
  const bind = vi.fn(
    async (): Promise<DeviceBinding<PlatformRuntimeOperations>> => ({
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
          networkDump: unavailable,
          screenRecordingStart: { available: true },
          screenRecordingReattach: { available: true },
          screenRecordingCleanup: { available: true },
        },
      },
      operations: {
        screenRecordingStart: start,
        screenRecordingReattach: async () => ({ status: 'missing' }),
        screenRecordingCleanup: async () => ({ status: 'already-missing' }),
      },
      [Symbol.asyncDispose]: async () => {},
    }),
  );
  const gateway: DeviceRuntimeGateway<PlatformRuntimeOperations> = {
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
