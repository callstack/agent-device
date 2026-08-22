import { vi } from 'vitest';
import type { AppLogCompletion, AppLogLiveHandle } from '@agent-device/contracts/app-log-runtime';
import type { CleanupOutcome, FinishOutcome } from '@agent-device/contracts/durable-resource';
import { localRuntimeOwner } from '@agent-device/contracts/platform-runtime';
import { createAppLogStartResult, createDurableResourceEnvelope } from '@agent-device/capture-kit';
import type { DeviceInfo } from '@agent-device/kernel/device';
import { makeSessionStore } from '../../__tests__/test-utils/store-factory.ts';
import { createTestAppLogLiveHandle } from '../../__tests__/test-utils/app-log-live-handle.ts';
import { createDurableCaptureAdmissionLedger } from '../durable-capture-admission-ledger.ts';
import { createDurableCaptureResource } from '../durable-capture-resource.ts';
import {
  createDurableCaptureResourceStore,
  type DurableCaptureResourceStore,
} from '../durable-capture-resource-store.ts';
import type { SessionState } from '../types.ts';

export const testCaptureStore = createDurableCaptureResourceStore({
  resourceKind: 'app-log',
  fileName: 'test-capture.resource.json',
  displayName: 'test capture',
});

export function createTestCaptureResource(
  store: DurableCaptureResourceStore<'app-log'> = testCaptureStore,
) {
  return createDurableCaptureResource<'app-log', AppLogLiveHandle, AppLogCompletion>({
    resourceKind: 'app-log',
    displayName: 'test capture',
    store,
    sessionSlot: {
      read: (session) => session.appLog,
      replace: (session, appLog) => ({ ...session, appLog, appLogFailure: undefined }),
    },
    completionMetadata: (completion) => ({
      outputPath: completion.outputPath,
      completedAt: completion.completedAt,
    }),
    messages: {
      noActive: 'no test capture active',
      cleanupPendingHint: 'Keep the test capture manifest for exact-owner recovery.',
    },
  });
}

export const testCaptureResource = createTestCaptureResource();

export function makeDurableCaptureContext(
  device: DeviceInfo = {
    platform: 'android',
    id: 'emulator-5554',
    name: 'Pixel',
    kind: 'emulator',
  },
) {
  const sessionStore = makeSessionStore('durable-capture-resource-');
  const sessionName = 'session';
  const session: SessionState = {
    name: sessionName,
    device,
    createdAt: 1,
    actions: [],
  };
  sessionStore.set(sessionName, session);
  return {
    admissionLedger: createDurableCaptureAdmissionLedger({ displayName: 'test capture' }),
    session,
    sessionName,
    sessionStore,
    device,
    owner: localRuntimeOwner(device.platform),
    fence: { token: 'fence', generation: 1 } as const,
    resourcePath: testCaptureStore.resolvePath(sessionStore.resolveSessionDir(sessionName)),
  };
}

export function makeDurableCaptureStartResult(
  context: ReturnType<typeof makeDurableCaptureContext>,
  options: {
    cleanup?: CleanupOutcome;
    cleanupError?: Error;
    finish?: FinishOutcome<AppLogCompletion>;
    finishError?: Error;
  } = {},
) {
  const forceCleanup = vi.fn(async () => {
    if (options.cleanupError) throw options.cleanupError;
    return options.cleanup ?? ({ status: 'cleaned' } as const);
  });
  const finish = vi.fn(async () => {
    if (options.finishError) throw options.finishError;
    return (
      options.finish ??
      ({
        status: 'completed',
        result: { backend: 'android', outputPath: '/tmp/app.log', completedAt: 2 },
      } as const)
    );
  });
  const handle = createTestAppLogLiveHandle({
    inspect: () => ({ backend: 'android', state: 'active', startedAt: 1 }),
    finish,
    forceCleanup,
  });
  const envelope = createDurableResourceEnvelope({
    resourceKind: 'app-log',
    sessionId: context.sessionName,
    device: {
      id: context.device.id,
      family: context.device.platform,
      ...(context.device.appleOs === undefined ? {} : { appleOs: context.device.appleOs }),
      kind: context.device.kind,
      ...(context.device.target === undefined ? {} : { target: context.device.target }),
      ...(context.device.iosPhysicalDeviceBackend === undefined
        ? {}
        : { iosPhysicalDeviceBackend: context.device.iosPhysicalDeviceBackend }),
    },
    owner: context.owner,
    fence: context.fence,
    lifecycle: 'open',
    descriptor: { version: 1, body: { pid: 123 } },
  });
  return {
    forceCleanup,
    finish,
    handle,
    ...createAppLogStartResult(handle, envelope),
  };
}
