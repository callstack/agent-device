import assert from 'node:assert/strict';
import { expect, test, vi } from 'vitest';
import type { AppleScreenRecordingRunnerRequest } from '@agent-device/contracts/platform';
import type { DeviceInfo } from '@agent-device/kernel/device';
import { localRuntimeOwner } from '@agent-device/contracts/platform-runtime';
import { createAppleScreenRecordingOperations, appleScreenRecordingFacts } from './runtime.ts';
import {
  appleRecordingHost as appleHost,
  coreDevice,
  coreDeviceRunnerStart,
  processIdentity,
  recordingInput as input,
  runnerOwnership,
  simulator,
} from './runtime.fixtures.ts';

test('uses the closed Apple runner and finalizer for a CoreDevice recording', async () => {
  const calls: string[] = [];
  const operations = createAppleScreenRecordingOperations({
    host: appleHost({
      apple: {
        availability: async () => ({ available: true }),
        runRunner: async (_device: DeviceInfo, request: AppleScreenRecordingRunnerRequest) => {
          calls.push(request.kind);
          return {
            ...coreDeviceRunnerStart,
            recorderStartUptimeMs: 10,
            targetAppReadyUptimeMs: 12,
          };
        },
        retrieveRunnerRecording: async (_device, remotePath, outputPath) => {
          calls.push(`retrieve:${remotePath}:${outputPath}`);
        },
        startSimulator: async () => {
          throw new Error('unused');
        },
      },
      complete: async ({ targetLabel }) => {
        calls.push(`finalize:${targetLabel}`);
        return { telemetryPath: '/tmp/capture.gesture-telemetry.json' };
      },
    }),
    device: coreDevice,
    owner: localRuntimeOwner('apple'),
    signal: new AbortController().signal,
  });
  const started = await operations.screenRecordingStart({
    sessionId: 'one',
    outputPath: '/tmp/capture.mp4',
    scope: 'app',
    showTouches: true,
    hideTouchesRequested: false,
    recordOnlySession: false,
    activeSessionApp: { bundleId: 'com.example.app' },
    fence: { token: 'fence', generation: 1 },
  });
  const outcome = await started.pendingHandle.transfer().finish();
  assert.equal(outcome.status, 'completed');
  if (outcome.status === 'completed') {
    assert.equal(outcome.result.telemetryPath, '/tmp/capture.gesture-telemetry.json');
  }
  assert.deepEqual(calls, [
    'start',
    'stop',
    'retrieve:tmp/agent-device-recording-123.mp4:/tmp/capture.mp4',
    'finalize:iOS recording',
  ]);
});

test('declares the exact XCTest backend failure before exposing operations', () => {
  const fact = appleScreenRecordingFacts({ ...coreDevice, iosPhysicalDeviceBackend: 'xctest' });
  assert.deepEqual(fact, {
    available: false,
    reason: 'unsupported-device-backend',
    hint: 'This command requires a CoreDevice-backed physical iOS device. The selected XCTest backend supports open, close, interactions, snapshots, and screenshots.',
  });
});

test('uses simctl on simulators and retains the macOS runner path', async () => {
  const calls: string[] = [];
  const ownedProcesses = { replace: vi.fn(), clear: vi.fn() };
  const host = appleHost({
    apple: {
      captureClockAnchor: async () => ({ wallClockAtMs: 100, uptimeMs: 50 }),
      startSimulator: async () => ({
        markers: [processIdentity],
        terminate: async () => {
          calls.push('simctl-stop');
        },
        wait: Promise.resolve({ stdout: '', stderr: '', exitCode: 0 }),
      }),
      runRunner: async (_device: DeviceInfo, request: AppleScreenRecordingRunnerRequest) => {
        calls.push(`runner:${request.kind}`);
        return request.kind === 'start' ? runnerOwnership : {};
      },
    },
    complete: async ({ targetLabel }) => {
      calls.push(`finalize:${targetLabel}`);
      return {};
    },
    ownedProcesses,
  });
  for (const runtimeDevice of [
    {
      platform: 'apple' as const,
      appleOs: 'ios' as const,
      id: 'sim',
      name: 'Simulator',
      kind: 'simulator' as const,
      target: 'mobile' as const,
      booted: true,
    },
    {
      platform: 'apple' as const,
      appleOs: 'macos' as const,
      id: 'mac',
      name: 'Mac',
      kind: 'device' as const,
      target: 'desktop' as const,
      booted: true,
    },
  ]) {
    const operations = createAppleScreenRecordingOperations({
      host,
      device: runtimeDevice,
      owner: localRuntimeOwner('apple'),
      signal: new AbortController().signal,
    });
    const started = await operations.screenRecordingStart({
      sessionId: runtimeDevice.id,
      outputPath: `/tmp/${runtimeDevice.id}.mp4`,
      scope: 'device',
      showTouches: false,
      hideTouchesRequested: false,
      recordOnlySession: false,
      activeSessionApp: { bundleId: 'com.example.app' },
      fence: { token: runtimeDevice.id, generation: 1 },
    });
    const handle = started.pendingHandle.transfer();
    if (runtimeDevice.kind === 'simulator') {
      expect(handle.inspect()).toMatchObject({
        gestureClockOriginAtMs: 100,
        gestureClockOriginUptimeMs: 50,
      });
    }
    await handle.finish();
  }
  expect(calls).toEqual([
    'simctl-stop',
    'finalize:iOS recording',
    'runner:start',
    'runner:stop',
    'finalize:macOS recording',
  ]);
  expect(ownedProcesses.replace).toHaveBeenCalledWith({ kind: 'session', sessionId: 'sim' }, [
    { ...processIdentity, purpose: 'simctl-screen-recording' },
  ]);
  expect(ownedProcesses.clear).toHaveBeenCalledWith({ kind: 'session', sessionId: 'sim' });
});

test('simulator cleanup waits for confirmed process exit and nonzero finish fails', async () => {
  let settleWait:
    | ((result: { stdout: string; stderr: string; exitCode: number }) => void)
    | undefined;
  const wait = new Promise<{ stdout: string; stderr: string; exitCode: number }>((resolve) => {
    settleWait = resolve;
  });
  const operations = createAppleScreenRecordingOperations({
    host: appleHost({
      apple: {
        startSimulator: async () => ({
          markers: [processIdentity],
          wait,
          terminate: async () => {},
        }),
        runRunner: async (_device, request) => (request.kind === 'start' ? runnerOwnership : {}),
      },
    }),
    device: simulator,
    owner: localRuntimeOwner('apple'),
    signal: new AbortController().signal,
  });
  const started = await operations.screenRecordingStart(input());
  const handle = started.pendingHandle.transfer();
  let settled = false;
  const cleanup = handle.forceCleanup().then((outcome) => {
    settled = true;
    return outcome;
  });
  await Promise.resolve();
  expect(settled).toBe(false);
  settleWait?.({ stdout: '', stderr: 'recording failed', exitCode: 1 });
  await expect(cleanup).resolves.toEqual({ status: 'cleaned' });

  const second = await operations.screenRecordingStart(input());
  await expect(second.pendingHandle.transfer().finish()).rejects.toThrow(
    'simctl recordVideo exited with code 1',
  );
});

test('runner cancellation after acquisition stops the recorder and preserves the exact reason', async () => {
  const controller = new AbortController();
  const reason = new Error('cancel runner acquisition');
  const calls: string[] = [];
  const operations = createAppleScreenRecordingOperations({
    host: appleHost({
      apple: {
        startSimulator: async () => {
          throw new Error('unused');
        },
        runRunner: async (_device, request) => {
          calls.push(request.kind);
          if (request.kind === 'start') controller.abort(reason);
          return request.kind === 'start' ? coreDeviceRunnerStart : {};
        },
      },
    }),
    device: coreDevice,
    owner: localRuntimeOwner('apple'),
    signal: controller.signal,
  });

  await expect(operations.screenRecordingStart(input({ scope: 'app' }))).rejects.toBe(reason);
  expect(calls).toEqual(['start', 'stop']);
});

test('rejects invalid simulator app scope before output or process acquisition', async () => {
  const prepare = vi.fn(async () => {});
  const startSimulator = vi.fn(async () => {
    throw new Error('must not start');
  });
  const operations = createAppleScreenRecordingOperations({
    host: appleHost({
      apple: { startSimulator },
      prepare,
    }),
    device: simulator,
    owner: localRuntimeOwner('apple'),
    signal: new AbortController().signal,
  });

  await expect(
    operations.screenRecordingStart(input({ scope: 'app', activeSessionApp: undefined })),
  ).rejects.toThrow('open the app under test before recording');
  expect(prepare).not.toHaveBeenCalled();
  expect(startSimulator).not.toHaveBeenCalled();
});

test('compensates a runner finalizer failure without stopping the runner twice', async () => {
  const stop = vi.fn(async () => ({}));
  const operations = createAppleScreenRecordingOperations({
    host: appleHost({
      apple: {
        runRunner: async (_device, request) =>
          request.kind === 'start' ? coreDeviceRunnerStart : await stop(),
      },
      complete: async () => {
        throw new Error('finalizer failed after runner stop');
      },
    }),
    device: coreDevice,
    owner: localRuntimeOwner('apple'),
    signal: new AbortController().signal,
  });
  const started = await operations.screenRecordingStart(input({ scope: 'app' }));
  const handle = started.pendingHandle.transfer();

  await expect(handle.finish()).rejects.toThrow('finalizer failed after runner stop');
  await expect(handle.forceCleanup()).resolves.toEqual({ status: 'cleaned' });
  expect(stop).toHaveBeenCalledOnce();
});
