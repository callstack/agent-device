import { PendingTransferGuard } from '@agent-device/contracts/async-lifecycle';
import { createDurableResourceEnvelope } from '@agent-device/capture-kit';
import { createPerfCaptureAdmissionLedger } from '@agent-device/capture-kit/perf-capture-admission-ledger';
import { perfCaptureResourceStore } from '@agent-device/capture-kit/perf-capture-resource-store';
import { localRuntimeOwner } from '@agent-device/contracts/platform-runtime';
import type { PerfNativeCaptureLiveHandle } from '@agent-device/contracts/perf-runtime';
import { deviceIdentity, type DeviceInfo } from '@agent-device/kernel/device';
import { AppError } from '@agent-device/kernel/errors';
import { expect, test, vi } from 'vitest';
import { makeSessionStore } from '../__tests__/support/store-factory.ts';
import type { SessionState } from './session-state.ts';
import { bindSessionPerfCapture } from './session-capture-binding.ts';
import {
  adoptStartedPerfCapture,
  finishLivePerfCapture,
} from '@agent-device/capture-kit/perf-capture-session-resource';

const device: DeviceInfo = {
  platform: 'android',
  id: 'emulator-5554',
  name: 'Pixel',
  kind: 'emulator',
  target: 'mobile',
  booted: true,
};
const fence = { token: 'fence', generation: 1 };

test('a failed live perf capture finish remains adopted for a later retry', async () => {
  const sessionStore = makeSessionStore('perf-capture-failed-finish-');
  const sessionName = 'capture';
  const session: SessionState = {
    name: sessionName,
    device,
    createdAt: 1,
    actions: [],
  };
  sessionStore.publish(sessionName, session);
  const capture = {
    kind: 'perfetto' as const,
    mode: 'trace' as const,
    state: 'running' as const,
    outPath: '/tmp/capture',
  };
  const pullFailure = new AppError('COMMAND_FAILED', 'Failed to pull Android perfetto artifact', {
    package: 'com.example.app',
    tool: 'perfetto',
    remotePath: '/data/misc/perfetto-traces/agent-device-app.trace',
    hint: 'Check that the profiling command ran long enough to create an artifact, then retry stop with the same session.',
  });
  let pullFails = true;
  const finish = vi.fn(async () => {
    if (pullFails) throw pullFailure;
    return {
      status: 'completed' as const,
      result: { ...capture, state: 'stopped' as const },
    };
  });
  const forceCleanup = vi.fn(async () => ({ status: 'cleaned' as const }));
  const handle: PerfNativeCaptureLiveHandle = {
    inspect: () => capture,
    setOutputPath: vi.fn(),
    finish,
    forceCleanup,
    [Symbol.asyncDispose]: async () => {},
  };
  const binding = bindSessionPerfCapture(sessionStore, sessionStore.lookup(sessionName)!);
  await adoptStartedPerfCapture({
    admissionLedger: createPerfCaptureAdmissionLedger(),
    binding,
    device,
    owner: localRuntimeOwner('android'),
    fence,
    pendingHandle: new PendingTransferGuard(handle),
    envelope: createDurableResourceEnvelope({
      resourceKind: 'perf-capture',
      sessionId: sessionName,
      device: deviceIdentity(device),
      owner: localRuntimeOwner('android'),
      fence,
      lifecycle: 'open',
      descriptor: { version: 1, body: { kind: 'fixture' } },
    }),
    throwIfCanceled: () => {},
  });
  const resourcePath = perfCaptureResourceStore.resolvePath(
    sessionStore.resolveSessionDir(sessionName),
  );
  const stop = () => finishLivePerfCapture({ intent: 'capture', binding });

  await expect(stop()).rejects.toBe(pullFailure);
  expect(forceCleanup).not.toHaveBeenCalled();
  expect(sessionStore.get(sessionName)?.perfCapture?.handle).toBeDefined();
  expect(perfCaptureResourceStore.read(resourcePath)).toMatchObject({
    status: 'decoded',
    envelope: { lifecycle: 'open', metadata: { phase: 'completing' } },
  });

  pullFails = false;
  await expect(stop()).resolves.toMatchObject({ kind: 'perfetto', state: 'stopped' });
  expect(forceCleanup).not.toHaveBeenCalled();
  expect(sessionStore.get(sessionName)?.perfCapture).toBeUndefined();
});
