import { vi } from 'vitest';
import {
  localRuntimeOwner,
  type AppLogCompletion,
  type AppLogLiveHandle,
  type CleanupOutcome,
  type FinishOutcome,
} from '@agent-device/contracts/platform';
import { createAppLogStartResult, createDurableResourceEnvelope } from '@agent-device/capture-kit';
import type { DeviceInfo } from '@agent-device/kernel/device';
import { makeSessionStore } from '../../__tests__/test-utils/store-factory.ts';
import { createTestAppLogLiveHandle } from '../../__tests__/test-utils/app-log-live-handle.ts';
import { createDurableCaptureAdmissionLedger } from '../durable-capture-admission-ledger.ts';
import { createDurableCaptureResource } from '../durable-capture-resource.ts';
import { createDurableCaptureResourceStore } from '../durable-capture-resource-store.ts';
import type { SessionState } from '../types.ts';

export const testCaptureStore = createDurableCaptureResourceStore({
  resourceKind: 'app-log',
  fileName: 'test-capture.resource.json',
  displayName: 'test capture',
});

export const testCaptureResource = createDurableCaptureResource<
  'app-log',
  AppLogLiveHandle,
  AppLogCompletion
>({
  resourceKind: 'app-log',
  displayName: 'test capture',
  store: testCaptureStore,
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
    finish?: FinishOutcome<AppLogCompletion>;
  } = {},
) {
  const forceCleanup = vi.fn(async () => options.cleanup ?? ({ status: 'cleaned' } as const));
  const finish = vi.fn(
    async () =>
      options.finish ??
      ({
        status: 'completed',
        result: { backend: 'android', outputPath: '/tmp/app.log', completedAt: 2 },
      } as const),
  );
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
