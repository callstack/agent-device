import { beforeEach, expect, test, vi } from 'vitest';
import { localRuntimeOwner } from '@agent-device/contracts/platform-runtime';
import { AppError } from '@agent-device/kernel/errors';
import type { DeviceInfo } from '@agent-device/kernel/device';
import { makeSessionStore } from '../../__tests__/test-utils/store-factory.ts';
import { createPerfCaptureAdmissionLedger } from '@agent-device/capture-kit/perf-capture-admission-ledger';
import { perfCaptureResourceStore } from '@agent-device/capture-kit/perf-capture-resource-store';
import {
  adoptStartedPerfCapture,
  finishLivePerfCapture,
} from '@agent-device/capture-kit/perf-capture-session-resource';
import { startAndroidPerfCapture } from '../../platform-runtime-perf-capture-host.ts';
import type { SessionState } from '../session-state.ts';

const androidNative = vi.hoisted(() => ({
  startAndroidSimpleperfProfile: vi.fn(),
  startAndroidPerfettoTrace: vi.fn(),
  stopAndroidSimpleperfProfile: vi.fn(),
  stopAndroidPerfettoTrace: vi.fn(),
  cleanupAndroidNativePerfSession: vi.fn(),
}));

vi.mock('@agent-device/platform-android/mechanics', () => androidNative);

const device: DeviceInfo = {
  platform: 'android',
  id: 'emulator-5554',
  name: 'Pixel',
  kind: 'emulator',
  target: 'mobile',
  booted: true,
};
const fence = { token: 'fence', generation: 1 };
const REMOTE_TRACE = '/data/misc/perfetto-traces/agent-device-app.trace';

beforeEach(() => {
  vi.clearAllMocks();
});

/**
 * ADR 0024 rule 6 for perf-capture: the retry needs the profiler artifact on the device. The stop's
 * own hint asks for a retry of the same session, and this kind's forced cleanup is the `rm -f` that
 * would empty that promise, so a failed stop preserves and the next stop re-pulls.
 */
test('a perf stop whose pull failed re-collects the device-side trace the first stop preserved', async () => {
  const sessionStore = makeSessionStore('perf-capture-failed-finish-');
  const sessionName = 'capture';
  const session: SessionState = {
    name: sessionName,
    device,
    createdAt: 1,
    actions: [],
  };
  sessionStore.set(sessionName, session);
  const capture = {
    action: 'start' as const,
    kind: 'perfetto' as const,
    type: 'trace' as const,
    packageName: 'com.example.app',
    appPid: '101',
    profilerPid: '202',
    remotePath: REMOTE_TRACE,
    outPath: '/tmp/capture',
    startedAt: 1,
    state: 'running' as const,
    method: 'native',
    message: 'started',
  };
  const remoteTraces = new Set([REMOTE_TRACE]);
  let pullFails = true;
  const pullFailure = new AppError('COMMAND_FAILED', 'Failed to pull Android perfetto artifact', {
    package: capture.packageName,
    tool: 'perfetto',
    remotePath: REMOTE_TRACE,
    hint: 'Check that the profiling command ran long enough to create an artifact, then retry stop with the same session.',
  });
  androidNative.startAndroidPerfettoTrace.mockImplementation(async () => {
    remoteTraces.add(capture.remotePath);
    return capture;
  });
  androidNative.stopAndroidPerfettoTrace.mockImplementation(
    async (_device: DeviceInfo, current: typeof capture, outPath: string) => {
      if (pullFails) throw pullFailure;
      if (!remoteTraces.has(current.remotePath)) {
        throw new AppError('COMMAND_FAILED', 'Failed to pull Android perfetto artifact');
      }
      remoteTraces.delete(current.remotePath);
      return {
        ...current,
        action: 'stop',
        state: 'stopped',
        outPath,
        stoppedAt: 3,
        durationMs: 2,
        summary: { packets: 4 },
      };
    },
  );
  androidNative.cleanupAndroidNativePerfSession.mockImplementation(
    async (_device: DeviceInfo, current: typeof capture) => {
      remoteTraces.delete(current.remotePath);
    },
  );

  const started = await startAndroidPerfCapture(device, localRuntimeOwner('android'), {
    sessionId: sessionName,
    appId: capture.packageName,
    kind: 'perfetto',
    mode: 'trace',
    outPath: '/tmp/capture',
    fence,
  });
  await adoptStartedPerfCapture({
    admissionLedger: createPerfCaptureAdmissionLedger(),
    session,
    sessionName,
    sessionStore,
    device,
    owner: localRuntimeOwner('android'),
    fence,
    pendingHandle: started.pendingHandle,
    envelope: started.envelope,
    throwIfCanceled: () => {},
  });
  const resourcePath = perfCaptureResourceStore.resolvePath(
    sessionStore.resolveSessionDir(sessionName),
  );
  const stop = () =>
    finishLivePerfCapture({
      intent: 'capture',
      session: sessionStore.get(sessionName) ?? session,
      sessionName,
      sessionStore,
    });

  await expect(stop()).rejects.toBe(pullFailure);
  expect(androidNative.cleanupAndroidNativePerfSession).not.toHaveBeenCalled();
  expect(remoteTraces).toEqual(new Set([REMOTE_TRACE]));
  expect(sessionStore.get(sessionName)?.perfCapture?.handle).toBeDefined();
  expect(perfCaptureResourceStore.read(resourcePath)).toMatchObject({
    status: 'decoded',
    envelope: { lifecycle: 'open', metadata: { phase: 'completing' } },
  });

  pullFails = false;
  await expect(stop()).resolves.toMatchObject({ kind: 'perfetto', state: 'stopped' });
  expect(remoteTraces).toEqual(new Set());
  expect(sessionStore.get(sessionName)?.perfCapture).toBeUndefined();
});
