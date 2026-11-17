import { afterEach, expect, test, vi } from 'vitest';
import { teardownDaemonSessionForShutdown } from './server-shutdown.ts';
import {
  clearRequestAbortRegistration,
  markRequestCanceled,
  registerRequestAbort,
} from '@agent-device/host-kit/request';
import { ANDROID_EMULATOR } from '@agent-device/test-kit';
import { makeAndroidSession } from '../../__tests__/support/session-factories.ts';
import { makeSessionStore } from '../../__tests__/support/store-factory.ts';
import { legacyDispatchCapture } from '../../__tests__/support/legacy-snapshot-capture-fixture.ts';
import { snapshotRuntimeFixture } from '../../__tests__/support/snapshot-runtime-fixture.ts';
import { platformResourceCleanupFixture } from '../../__tests__/support/platform-resource-cleanup-fixture.ts';
import { DAEMON_SESSION_TEARDOWN_TIMEOUT_MS } from '../../sessions/session-teardown-budget.ts';
import { dispatchSnapshotViaRuntime } from '../../sessions/snapshot-runtime.ts';
import { forwardingCreateCommandSurface } from '../../__tests__/support/command-surface-fake.ts';

vi.mock('@agent-device/device-selection/dispatch-resolve', () => ({
  resolveTargetDevice: vi.fn(async () => ANDROID_EMULATOR),
}));

const platformResourceCleanup = platformResourceCleanupFixture();

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

afterEach(() => {
  vi.useRealTimers();
  vi.clearAllMocks();
  legacyDispatchCapture.mockReset();
});

for (const initialSession of ['published', 'draft'] as const) {
  test(`bounded shutdown refuses a late ${initialSession} snapshot`, async () => {
    const sessionStore = makeSessionStore();
    const address = 'cwd:shutdown-capture:default';
    const shutdownRef = sessionStore.publish(
      initialSession === 'published' ? address : 'shutdown-owner',
      makeAndroidSession('default'),
    );
    const captureEntered = deferred();
    const releaseCapture = deferred();
    const cleanupEntered = deferred();
    const releaseCleanup = deferred();
    const registration = registerRequestAbort(`shutdown-snapshot-${initialSession}`)!;
    legacyDispatchCapture.mockImplementation(async () => {
      captureEntered.resolve();
      await releaseCapture.promise;
      return { nodes: [], truncated: false, backend: 'uiautomator' };
    });
    vi.mocked(platformResourceCleanup.stopSnapshotHelper).mockImplementation(async () => {
      cleanupEntered.resolve();
      await releaseCleanup.promise;
    });
    const running = dispatchSnapshotViaRuntime({
      createCommandSurface: forwardingCreateCommandSurface,
      req: {
        command: 'snapshot',
        positionals: [],
        token: 'test',
        session: address,
        meta: { requestId: registration.requestId },
      },
      sessionName: address,
      logPath: '/dev/null',
      sessionStore,
      ...snapshotRuntimeFixture(registration.requestId),
      platformResourceCleanup,
    });
    const result = running.then(
      (response) => ({ response }),
      (error: unknown) => ({ error }),
    );
    const stderr: string[] = [];
    let teardown: Promise<boolean> | undefined;
    try {
      await captureEntered.promise;
      vi.useFakeTimers();
      sessionStore.closeAdmission();
      markRequestCanceled(registration.requestId);
      teardown = teardownDaemonSessionForShutdown({
        ref: shutdownRef,
        sessionStore,
        stderr: { write: (chunk) => stderr.push(chunk) },
        platformCleanup: platformResourceCleanup,
      });
      await cleanupEntered.promise;
      await vi.advanceTimersByTimeAsync(DAEMON_SESSION_TEARDOWN_TIMEOUT_MS);
      await teardown;
      expect(stderr.join('')).toContain('Daemon session teardown timed out (default).');
      expect(sessionStore.resolveCurrent(shutdownRef)).toBeUndefined();
      expect(registration.controller.signal.aborted).toBe(true);
      releaseCapture.resolve();
      expect(await result).toMatchObject({
        error: {
          details: {
            reason:
              initialSession === 'published' ? 'session_lifetime_ended' : 'daemon_shutting_down',
          },
        },
      });
      expect(sessionStore.lookup(address)).toBeUndefined();
      expect(sessionStore.lookup('default')).toBeUndefined();
      expect(platformResourceCleanup.stopSnapshotHelper).toHaveBeenCalledExactlyOnceWith(
        ANDROID_EMULATOR,
      );
    } finally {
      releaseCapture.resolve();
      releaseCleanup.resolve();
      await result;
      await teardown;
      clearRequestAbortRegistration(registration);
      vi.useRealTimers();
    }
  });
}
