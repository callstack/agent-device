import fs from 'node:fs';
import { expect, test, vi } from 'vitest';
import {
  clearRequestCanceled,
  markRequestCanceled,
  throwIfRequestCanceled,
} from '@agent-device/host-kit/request';
import { AppError } from '@agent-device/kernel/errors';
import { applicationLifecycleOperationFacts } from '@agent-device/contracts/application-lifecycle-runtime';
import {
  type DeviceBinding,
  type DeviceRuntimeGateway,
  localRuntimeOwner,
} from '@agent-device/contracts/platform-runtime';
import type { PlatformRuntimeOperations } from '@agent-device/contracts/platform-runtime-operations';
import { createAppLogStartResult, createDurableResourceEnvelope } from '@agent-device/capture-kit';
import {
  createTestAppLogLiveHandle,
  unavailableDeploymentSnapshotAndShutdownOperationFacts,
} from '@agent-device/test-kit';
import { createTestDeviceInventoryGateways } from '@agent-device/device-selection/inventory-gateways-fixtures';
import { makeSessionStore } from '../../__tests__/support/store-factory.ts';
import { LeaseRegistry } from '../../resources/lease-registry.ts';
import { createRequestHandler } from '../../__tests__/support/test-device-runtime-gateway.ts';
import { fakeCreateCommandSurface } from '../../__tests__/support/command-surface-fake.ts';

test('request binding disposes once after response while adopted app-log handle survives', async () => {
  const runtime = makeGateway();
  const { handler, sessionStore } = makeHandler(runtime.gateway);
  const response = await handler(request(['start']));

  expect(response).toMatchObject({ ok: true, data: { started: true } });
  expect(runtime.bind).toHaveBeenCalledOnce();
  expect(runtime.bindingDispose).toHaveBeenCalledOnce();
  expect(runtime.forceCleanup).not.toHaveBeenCalled();
  expect(sessionStore.get('session')?.appLog?.handle).toBe(runtime.handle);
});

test('primary request failure survives a rejecting binding disposal', async () => {
  const cleanupFailure = new Error('binding dispose failed');
  const runtime = makeGateway(cleanupFailure);
  const { handler } = makeHandler(runtime.gateway);
  const response = await handler(request(['invalid']));

  expect(response).toMatchObject({
    ok: false,
    error: { code: 'INVALID_ARGS', message: expect.stringContaining('logs requires') },
  });
  expect(runtime.bindingDispose).toHaveBeenCalledOnce();
  if (response.ok || !response.error.logPath) throw new Error('expected request diagnostics path');
  const phases = fs
    .readFileSync(response.error.logPath, 'utf8')
    .trim()
    .split('\n')
    .map((line) => (JSON.parse(line) as { phase: string }).phase);
  expect(phases).toContain('request_failed');
  expect(phases).toContain('request_binding_cleanup_failed');
});

for (const outcome of ['success', 'throw', 'cancellation'] as const) {
  for (const key of ['session', 'device'] as const) {
    test(`binding cleanup holds the ${key} execution lock after ${outcome}`, async () => {
      const runtime = makeGateway();
      const { handler, sessionStore } = makeHandler(runtime.gateway);
      const current = sessionStore.get('session')!;
      sessionStore.publish('other-session', { ...current, name: 'other-session', actions: [] });
      const requestId = `cleanup-${key}-${outcome}`;
      let markCleanupStarted: () => void = () => {};
      let finishCleanup: () => void = () => {};
      const cleanupStarted = new Promise<void>((resolve) => {
        markCleanupStarted = resolve;
      });
      const cleanupFinished = new Promise<void>((resolve) => {
        finishCleanup = resolve;
      });
      runtime.bindingDispose.mockImplementationOnce(async () => {
        markCleanupStarted();
        await cleanupFinished;
      });
      let doctorCalls = 0;
      vi.spyOn(runtime.operations, 'appLogDoctor').mockImplementation(async () => {
        if (doctorCalls++ > 0) return { backend: 'android', checks: {}, notes: [] };
        if (outcome === 'throw') throw new AppError('COMMAND_FAILED', 'doctor failed');
        if (outcome === 'cancellation') {
          markRequestCanceled(requestId);
          throwIfRequestCanceled(requestId);
        }
        return { backend: 'android', checks: {}, notes: [] };
      });
      const first = handler({ ...request(['doctor']), meta: { requestId } });
      await cleanupStarted;
      const second = handler({
        ...request(['doctor']),
        session: key === 'session' ? 'session' : 'other-session',
        meta: { requestId: `${requestId}-queued` },
      });
      try {
        await new Promise<void>((resolve) => setImmediate(resolve));
        expect(runtime.bind).toHaveBeenCalledTimes(1);
      } finally {
        finishCleanup();
        clearRequestCanceled(requestId);
      }
      const [firstResponse, secondResponse] = await Promise.all([first, second]);
      expect(firstResponse.ok).toBe(outcome === 'success');
      if (outcome === 'cancellation') {
        expect(firstResponse).toMatchObject({
          ok: false,
          error: { code: 'COMMAND_FAILED', details: { reason: 'request_canceled' } },
        });
      }
      expect(secondResponse.ok).toBe(true);
      expect(runtime.bind).toHaveBeenCalledTimes(2);
      expect(runtime.bindingDispose).toHaveBeenCalledTimes(2);
    });
  }
}

function makeHandler(gateway: DeviceRuntimeGateway<PlatformRuntimeOperations>) {
  const sessionStore = makeSessionStore('request-runtime-binding-router-');
  sessionStore.publish('session', {
    name: 'session',
    device: { platform: 'android', id: 'emulator-5554', name: 'Pixel', kind: 'emulator' },
    appBundleId: 'com.example.app',
    createdAt: Date.now(),
    actions: [],
  });
  return {
    sessionStore,
    handler: createRequestHandler({
      createCommandSurface: fakeCreateCommandSurface,
      logPath: '/tmp/daemon.log',
      token: 'token',
      sessionStore,
      leaseRegistry: new LeaseRegistry(),
      deviceInventoryGateways: createTestDeviceInventoryGateways(),
      deviceRuntimeGateway: gateway,
      trackDownloadableArtifact: () => 'artifact',
    }),
  };
}

function request(positionals: string[]) {
  return {
    token: 'token',
    session: 'session',
    command: 'logs',
    positionals,
    flags: {},
    meta: { requestId: `logs-${positionals[0]}` },
  };
}

function makeGateway(disposeError?: Error) {
  const owner = localRuntimeOwner('android');
  const forceCleanup = vi.fn(async () => ({ status: 'cleaned' as const }));
  const handle = createTestAppLogLiveHandle({
    inspect: () => ({ backend: 'android', state: 'active', startedAt: 1 }),
    finish: async () => ({
      status: 'completed',
      result: { backend: 'android', outputPath: '/tmp/app.log', completedAt: 2 },
    }),
    forceCleanup,
  });
  const operations: DeviceBinding<PlatformRuntimeOperations>['operations'] = {
    appLogInspect: async () => ({ backend: 'android' }),
    appLogDoctor: async () => ({ backend: 'android', checks: {}, notes: [] }),
    appLogStart: async (input) =>
      createAppLogStartResult(
        handle,
        createDurableResourceEnvelope({
          resourceKind: 'app-log',
          sessionId: input.sessionId,
          device: { id: 'emulator-5554', family: 'android', kind: 'emulator' },
          owner,
          fence: input.fence,
          lifecycle: 'open',
          descriptor: { version: 1, body: {} },
        }),
      ),
    appLogReattach: async () => ({ status: 'missing' }),
    appLogCleanup: async () => ({ status: 'cleaned' }),
    networkDump: async (input) => ({
      source: 'app-log',
      backend: 'android',
      dump: {
        path: '/tmp/app.log',
        exists: false,
        scannedLines: 0,
        matchedLines: 0,
        entries: [],
        include: input.include,
        limits: {
          maxEntries: input.maxEntries,
          maxPayloadChars: input.maxPayloadChars,
          maxScanLines: input.maxScanLines,
        },
      },
      notes: [],
    }),
  };
  const bindingDispose = vi.fn(async () => {
    if (disposeError) throw disposeError;
  });
  const bind = vi.fn(async ({ device }) => ({
    device,
    owner,
    facts: {
      device: { family: 'android' as const, kind: device.kind, providerMode: 'local' as const },
      operations: {
        appLogInspect: { available: true as const },
        appLogDoctor: { available: true as const },
        appLogStart: { available: true as const },
        appLogReattach: { available: true as const },
        appLogCleanup: { available: true as const },
        appState: { available: false as const, reason: 'owner-capability-missing' as const },
        networkDump: { available: true as const },
        screenRecordingStart: unavailableRecording,
        screenRecordingReattach: unavailableRecording,
        screenRecordingCleanup: unavailableRecording,
        ensureReady: { available: true as const },
        bootTarget: { available: true as const },
        bootTargetHeadless: unavailableRecording,
        listApps: unavailableRecording,
        ...unavailableDeploymentSnapshotAndShutdownOperationFacts,
        ...applicationLifecycleOperationFacts({
          resolveOpenTarget: unavailableRecording,
          prepareApplicationOpen: unavailableRecording,
          openApplication: unavailableRecording,
          applyRuntimeHints: unavailableRecording,
          clearRuntimeHints: unavailableRecording,
          closeApplication: unavailableRecording,
          finalizeApplicationClose: unavailableRecording,
          prepareAppleRunner: unavailableRecording,
          configureProviderPortReverse: unavailableRecording,
        }),
      },
    },
    operations,
    [Symbol.asyncDispose]: bindingDispose,
  }));
  const gateway: DeviceRuntimeGateway<PlatformRuntimeOperations> = {
    inspectFacts: async () => {
      throw new Error('unused');
    },
    bind,
    shutdown: async () => {},
  };
  return { gateway, bind, bindingDispose, forceCleanup, handle, operations };
}

const unavailableRecording = Object.freeze({
  available: false as const,
  reason: 'owner-capability-missing' as const,
});
