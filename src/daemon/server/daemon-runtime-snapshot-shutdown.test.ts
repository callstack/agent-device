import { afterEach, expect, test, vi } from 'vitest';
import {
  clearRequestAbortRegistration,
  markRequestCanceled,
  registerRequestAbort,
} from '@agent-device/host-kit/request';
import { ANDROID_EMULATOR } from '../../__tests__/test-utils/device-fixtures.ts';
import { makeAndroidSession } from '../../__tests__/test-utils/session-factories.ts';
import { makeSessionStore } from '../../__tests__/test-utils/store-factory.ts';
import { legacyDispatchCapture } from '../__tests__/legacy-snapshot-capture-fixture.ts';
import { snapshotRuntimeFixture } from '../__tests__/snapshot-runtime-fixture.ts';
import { platformResourceCleanup } from '../../platform-runtime-resource-cleanup.ts';
import { DAEMON_SESSION_TEARDOWN_TIMEOUT_MS } from '../session-teardown-budget.ts';
import { dispatchSnapshotViaRuntime } from '../snapshot-runtime.ts';
import { teardownDaemonSessionForShutdown } from './daemon-runtime.ts';

vi.mock('@agent-device/device-selection/dispatch-resolve', () => ({
  resolveTargetDevice: vi.fn(async () => ANDROID_EMULATOR),
}));
vi.mock('../device/device-ready.ts', () => ({ ensureDeviceReady: vi.fn(async () => {}) }));
vi.mock('../../platform-runtime-resource-cleanup.ts', () => ({
  platformResourceCleanup: {
    stopSnapshotHelper: vi.fn(),
    closeManagedBrowser: vi.fn(async () => {}),
    cleanupSessionlessExecutionHost: vi.fn(async () => {}),
    retainExecutionHostAfterClose: vi.fn(() => false),
  },
}));

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
    let teardown: Promise<void> | undefined;
    try {
      await captureEntered.promise;
      vi.useFakeTimers();
      sessionStore.closeAdmission();
      markRequestCanceled(registration.requestId);
      teardown = teardownDaemonSessionForShutdown({
        ref: shutdownRef,
        sessionStore,
        stderr: { write: (chunk) => stderr.push(chunk) },
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
