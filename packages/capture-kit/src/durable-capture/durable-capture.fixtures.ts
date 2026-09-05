import path from 'node:path';
import { vi } from 'vitest';
import {
  isConfirmedCleanup,
  type CleanupOutcome,
  type FinishOutcome,
} from '@agent-device/contracts/durable-resource';
import { localRuntimeOwner } from '@agent-device/contracts/platform-runtime';
import { PendingTransferGuard } from '@agent-device/contracts/async-lifecycle';
import type { DeviceInfo } from '@agent-device/kernel/device';
import { createDurableResourceEnvelope } from '../durable-resource-envelope.ts';
import { mkdtempForTestSync } from '../tmp-dir.fixtures.ts';
import type {
  DurableCaptureResourceDefinition,
  DurableCaptureSessionResource,
  DurableCaptureSessionStore,
} from './definition.ts';
import { createDurableCaptureResourceStore, type DurableCaptureResourceStore } from './store.ts';

/**
 * A resource kind of its own, not one of the daemon's four. The mechanics are generic over the
 * kind, so exercising them through a kind nothing else stamps keeps these tests from asserting
 * a real domain's naming by accident.
 */
export const TEST_CAPTURE_KIND = 'test-capture';

export type TestCaptureCompletion = Readonly<{ outputPath: string; completedAt: number }>;

export type TestCaptureHandle = AsyncDisposable &
  Readonly<{
    finish(): Promise<FinishOutcome<TestCaptureCompletion>>;
    forceCleanup(): Promise<CleanupOutcome>;
  }>;

/** The whole session type these mechanics ever see: one slot, and nothing daemon-shaped. */
export type TestCaptureSession = Readonly<{
  name: string;
  capture?: DurableCaptureSessionResource<typeof TEST_CAPTURE_KIND, TestCaptureHandle>;
}>;

export const testCaptureStore = createDurableCaptureResourceStore({
  resourceKind: TEST_CAPTURE_KIND,
  fileName: 'test-capture.resource.json',
  displayName: 'test capture',
});

export function createTestCaptureDefinition(
  store: DurableCaptureResourceStore<typeof TEST_CAPTURE_KIND> = testCaptureStore,
): DurableCaptureResourceDefinition<
  typeof TEST_CAPTURE_KIND,
  TestCaptureHandle,
  TestCaptureCompletion,
  TestCaptureSession
> {
  return {
    resourceKind: TEST_CAPTURE_KIND,
    displayName: 'test capture',
    store,
    sessionSlot: {
      read: (session) => session.capture,
      replace: (session, capture) => ({ ...session, capture }),
    },
    completionMetadata: (completion) => ({
      outputPath: completion.outputPath,
      completedAt: completion.completedAt,
    }),
    messages: {
      noActive: 'no test capture active',
      cleanupPendingHint: 'Keep the test capture manifest for exact-owner recovery.',
    },
  };
}

export const testCaptureDefinition = createTestCaptureDefinition();

export function makeDurableCaptureContext(
  device: DeviceInfo = {
    platform: 'android',
    id: 'emulator-5554',
    name: 'Pixel',
    kind: 'emulator',
  },
) {
  const sessionsDir = mkdtempForTestSync('durable-capture-resource-');
  const sessionName = 'session';
  const sessions = new Map<string, TestCaptureSession>();
  const session: TestCaptureSession = { name: sessionName };
  sessions.set(sessionName, session);
  const resolveSessionDir = (name: string): string => path.join(sessionsDir, name);
  const sessionStore: DurableCaptureSessionStore<TestCaptureSession> = {
    set: (name, next) => void sessions.set(name, next),
    resolveSessionDir,
  };
  return {
    reportUndurableCleanup: vi.fn(),
    sessions,
    sessionsDir,
    resolveSessionDir,
    session,
    sessionName,
    sessionStore,
    device,
    owner: localRuntimeOwner(device.platform),
    fence: { token: 'fence', generation: 1 } as const,
    resourcePath: testCaptureStore.resolvePath(resolveSessionDir(sessionName)),
  };
}

export function makeDurableCaptureStartResult(
  context: ReturnType<typeof makeDurableCaptureContext>,
  options: {
    cleanup?: CleanupOutcome;
    cleanupError?: Error;
    finish?: FinishOutcome<TestCaptureCompletion>;
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
      ({ status: 'completed', result: { outputPath: '/tmp/app.log', completedAt: 2 } } as const)
    );
  });
  // The same shape every shipped live handle has: finish and cleanup run once, and disposing an
  // unconfirmed cleanup throws — the signal a failed adoption reports as an unconfirmed cleanup.
  let cleanup: Promise<CleanupOutcome> | undefined;
  let disposal: Promise<void> | undefined;
  const forceCleanupOnce = (): Promise<CleanupOutcome> => (cleanup ??= forceCleanup());
  const handle: TestCaptureHandle = {
    finish,
    forceCleanup: forceCleanupOnce,
    [Symbol.asyncDispose]: async () => {
      disposal ??= forceCleanupOnce().then((outcome) => {
        if (isConfirmedCleanup(outcome)) return;
        throw new Error(outcome.message ?? 'Test capture cleanup could not be confirmed');
      });
      await disposal;
    },
  };
  const envelope = createDurableResourceEnvelope({
    resourceKind: TEST_CAPTURE_KIND,
    sessionId: context.sessionName,
    device: {
      id: context.device.id,
      family: context.device.platform,
      kind: context.device.kind,
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
    pendingHandle: new PendingTransferGuard(handle),
    envelope,
  };
}
