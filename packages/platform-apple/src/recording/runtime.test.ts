import assert from 'node:assert/strict';
import { expect, test, vi } from 'vitest';
import { AppError } from '@agent-device/kernel/errors';
import { RECORDING_OUTPUT_UNPLAYABLE_REASON } from '@agent-device/contracts/screen-recording-runtime';
import type { AppleScreenRecordingRunnerRequest } from '@agent-device/contracts/screen-recording-runtime-host';
import type { DeviceInfo } from '@agent-device/kernel/device';
import { recordingFileStore } from '@agent-device/capture-kit/recording-artifact-fixtures';
import { localRuntimeOwner } from '@agent-device/contracts/platform-runtime';
import { createAppleScreenRecordingOperations, appleScreenRecordingFacts } from './runtime.ts';
import {
  appleRecordingHost as appleHost,
  coreDevice,
  coreDeviceRunnerStart,
  processIdentity,
  recordingInput as input,
  recordingOutputPath,
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
  const handle = started.pendingHandle.transfer();
  expect(handle.inspect()).toMatchObject({
    gestureClockOriginUptimeMs: 10,
    runnerStartedAtUptimeMs: 10,
  });
  const outcome = await handle.finish();
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

test('a runner recording that wrote on the device reports that path as owed a retirement', async () => {
  const operations = createAppleScreenRecordingOperations({
    host: appleHost(),
    device: coreDevice,
    owner: localRuntimeOwner('apple'),
    signal: new AbortController().signal,
  });
  const handle = (await operations.screenRecordingStart(input())).pendingHandle.transfer();

  await expect(handle.finish()).resolves.toMatchObject({
    status: 'completed',
    result: {
      stopObservation: { recorder: 'confirmed' },
      // The stop RPC was acknowledged and the file was retrieved off the device, so nothing removes
      // it here — retiring it is owed, and saying so is what lets a later step do it (ADR 0024 2.3).
      nativePathDisposition: 'retirable',
    },
  });
});

test('an invalidated runner recording still names its device-side path as owed', async () => {
  const operations = createAppleScreenRecordingOperations({
    host: appleHost(),
    device: coreDevice,
    owner: localRuntimeOwner('apple'),
    signal: new AbortController().signal,
  });
  const handle = (
    await operations.screenRecordingStart(input({ showTouches: true }))
  ).pendingHandle.transfer();
  handle.invalidate('runner restarted');

  await expect(handle.finish()).resolves.toMatchObject({
    status: 'completed',
    result: {
      // Losing the session that held the recorder says nothing about who stopped writing, while the
      // file the runner left on the device is still there to be retired.
      stopObservation: { recorder: 'lost', why: 'owner-session-lost' },
      nativePathDisposition: 'retirable',
      overlayWarning: 'overlay unavailable: runner restarted',
    },
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
      outputPath: recordingOutputPath(`${runtimeDevice.id}.mp4`),
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

test('a simulator stop exports from a copy and retires the file the recorder owned', async () => {
  const exportPath = recordingOutputPath('export-only.mp4');
  const nativePath = exportPath.replace(/\.mp4$/, '.native.mp4');
  const collectedPath = exportPath.replace(/\.mp4$/, '.collected.mp4');
  const files = recordingFileStore();
  const saw: string[] = [];
  const operations = createAppleScreenRecordingOperations({
    host: appleHost({
      files,
      apple: {
        startSimulator: async (_device, recorderPath) => {
          saw.push(`record:${recorderPath}`);
          return {
            markers: [processIdentity],
            wait: Promise.resolve({ stdout: '', stderr: '', exitCode: 0 }),
            terminate: async () => {},
          };
        },
      },
      sniff: async ({ outputPath }) => {
        saw.push(`sniff:${outputPath}`);
      },
      complete: async ({ outputPath }) => {
        saw.push(`finalize:${outputPath}`);
        return {};
      },
    }),
    device: simulator,
    owner: localRuntimeOwner('apple'),
    signal: new AbortController().signal,
  });

  const started = await operations.screenRecordingStart({
    ...input(),
    outputPath: exportPath,
  });
  const handle = started.pendingHandle.transfer();
  expect(saw).toEqual([`record:${nativePath}`]);
  // The recorder owns its path while it writes, so the caller's path is not theirs to see yet.
  expect(files.exists(exportPath)).toBe(false);

  const outcome = await handle.finish();

  expect(outcome.status).toBe('completed');
  if (outcome.status !== 'completed') return;
  expect(outcome.result).toMatchObject({ nativePathDisposition: 'retired' });
  expect(saw).toEqual([`record:${nativePath}`, `sniff:${collectedPath}`, `finalize:${exportPath}`]);
  expect(files.exists(exportPath)).toBe(true);
  expect(files.exists(nativePath)).toBe(false);
  expect(files.exists(collectedPath)).toBe(false);
});

test('a simulator export the finalizer refuses leaves the caller path empty and the copy for the retry', async () => {
  const exportPath = recordingOutputPath('refused.mp4');
  const nativePath = exportPath.replace(/\.mp4$/, '.native.mp4');
  const collectedPath = exportPath.replace(/\.mp4$/, '.collected.mp4');
  const files = recordingFileStore();
  const operations = createAppleScreenRecordingOperations({
    host: appleHost({
      files,
      apple: {
        startSimulator: async () => ({
          markers: [processIdentity],
          wait: Promise.resolve({ stdout: '', stderr: '', exitCode: 0 }),
          terminate: async () => {},
        }),
      },
      complete: async () => {
        throw new Error('recording was not finalized into a playable video');
      },
    }),
    device: simulator,
    owner: localRuntimeOwner('apple'),
    signal: new AbortController().signal,
  });
  const started = await operations.screenRecordingStart({ ...input(), outputPath: exportPath });

  await expect(started.pendingHandle.transfer().finish()).rejects.toThrow('playable video');

  // `--out` only ever holds bytes the finalizer accepted; the recorder's file and the copy stay.
  expect(files.exists(exportPath)).toBe(false);
  expect(files.exists(collectedPath)).toBe(true);
  expect(files.exists(nativePath)).toBe(true);
});

test('simulator cleanup waits for confirmed process exit', async () => {
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
});

test('a simulator recorder that exited early is collected and its exit is disclosed', async () => {
  const operations = createAppleScreenRecordingOperations({
    host: appleHost({
      apple: {
        startSimulator: async () => ({
          markers: [processIdentity],
          wait: Promise.resolve({ stdout: '', stderr: 'recording failed', exitCode: 1 }),
          terminate: async () => {},
        }),
      },
      complete: async () => ({ telemetryPath: '/tmp/capture.gesture-telemetry.json' }),
    }),
    device: simulator,
    owner: localRuntimeOwner('apple'),
    signal: new AbortController().signal,
  });
  const started = await operations.screenRecordingStart(input());

  await expect(started.pendingHandle.transfer().finish()).resolves.toMatchObject({
    status: 'completed',
    result: {
      // An exited recorder is a fact about the recorder even when its exit explains nothing.
      stopObservation: { recorder: 'confirmed' },
      warning:
        'simctl recordVideo exited with code 1 before record stop; the video covers only what ' +
        'the recorder wrote before it stopped.',
    },
  });
});

test('a refused simulator finish is re-driven by the next record stop', async () => {
  let finalizeCalls = 0;
  const finalize = async () => {
    finalizeCalls += 1;
    if (finalizeCalls === 1) {
      throw new AppError('COMMAND_FAILED', 'recording was not finalized into a playable video', {
        reason: RECORDING_OUTPUT_UNPLAYABLE_REASON,
        retriable: true,
      });
    }
    return {};
  };
  const operations = createAppleScreenRecordingOperations({
    host: appleHost({
      apple: {
        startSimulator: async () => ({
          markers: [processIdentity],
          wait: Promise.resolve({ stdout: '', stderr: 'recordVideo lost its stream', exitCode: 1 }),
          terminate: async () => {},
        }),
      },
      complete: finalize,
    }),
    device: simulator,
    owner: localRuntimeOwner('apple'),
    signal: new AbortController().signal,
  });
  const handle = (await operations.screenRecordingStart(input())).pendingHandle.transfer();

  await expect(handle.finish()).rejects.toThrow(
    /was not finalized into a playable video; simctl recordVideo exited with code 1/,
  );
  await expect(handle.finish()).resolves.toMatchObject({ status: 'completed' });
  expect(finalizeCalls).toBe(2);
});

test('an unreadable recording names the exit that made it permanent and the way out', async () => {
  const operations = createAppleScreenRecordingOperations({
    host: appleHost({
      apple: {
        startSimulator: async () => ({
          markers: [processIdentity],
          wait: Promise.resolve({
            stdout: '',
            stderr: 'error: the recorder died mid-write',
            exitCode: null,
            signal: 'SIGKILL',
          }),
          terminate: async () => {},
        }),
      },
      complete: async () => {
        throw new AppError('COMMAND_FAILED', 'recording was not finalized into a playable video', {
          reason: 'recording-output-unplayable',
          retriable: true,
        });
      },
    }),
    device: simulator,
    owner: localRuntimeOwner('apple'),
    signal: new AbortController().signal,
  });
  const handle = (await operations.screenRecordingStart(input())).pendingHandle.transfer();

  await expect(handle.finish()).rejects.toMatchObject({
    code: 'COMMAND_FAILED',
    message:
      'recording was not finalized into a playable video; simctl recordVideo was killed by SIGKILL',
    details: {
      reason: 'recording-output-unplayable',
      exitCode: null,
      signal: 'SIGKILL',
      stderr: 'error: the recorder died mid-write',
      retriable: false,
      hint: expect.stringContaining('Close this session'),
    },
  });
});

test('an export failure the recorder did not cause keeps its own verdict', async () => {
  const transient = new AppError('COMMAND_FAILED', 'recording telemetry could not be written', {
    reason: 'telemetry-write-failed',
    retriable: true,
    hint: 'Retry record stop.',
  });
  const operations = createAppleScreenRecordingOperations({
    host: appleHost({
      apple: {
        startSimulator: async () => ({
          markers: [processIdentity],
          wait: Promise.resolve({ stdout: '', stderr: '', exitCode: 1 }),
          terminate: async () => {},
        }),
      },
      complete: async () => {
        throw transient;
      },
    }),
    device: simulator,
    owner: localRuntimeOwner('apple'),
    signal: new AbortController().signal,
  });
  const handle = (await operations.screenRecordingStart(input())).pendingHandle.transfer();

  await expect(handle.finish()).rejects.toBe(transient);
});

test('a recorder that record stop terminated itself is collected without a warning', async () => {
  const operations = createAppleScreenRecordingOperations({
    host: appleHost({
      apple: {
        startSimulator: async () => ({
          markers: [processIdentity],
          // The host normalizes a termination record stop asked for: exit code 0, signal kept.
          wait: Promise.resolve({ stdout: '', stderr: '', exitCode: 0, signal: 'SIGTERM' }),
          terminate: async () => {},
        }),
      },
      complete: async () => ({}),
    }),
    device: simulator,
    owner: localRuntimeOwner('apple'),
    signal: new AbortController().signal,
  });

  const outcome = await (
    await operations.screenRecordingStart(input())
  ).pendingHandle
    .transfer()
    .finish();
  assert.equal(outcome.status, 'completed');
  if (outcome.status === 'completed') assert.equal(outcome.result.warning, undefined);
});

test('a refused runner stop is asked again by the next record stop', async () => {
  const calls: string[] = [];
  const operations = createAppleScreenRecordingOperations({
    host: appleHost({
      apple: {
        runRunner: async (_device: DeviceInfo, request: AppleScreenRecordingRunnerRequest) => {
          calls.push(request.kind);
          if (request.kind === 'stop' && calls.filter((call) => call === 'stop').length === 1) {
            throw new Error('macOS runner recordStop rejected');
          }
          return request.kind === 'start' ? coreDeviceRunnerStart : {};
        },
      },
      complete: async () => ({}),
    }),
    device: coreDevice,
    owner: localRuntimeOwner('apple'),
    signal: new AbortController().signal,
  });
  const handle = (
    await operations.screenRecordingStart(input({ scope: 'app' }))
  ).pendingHandle.transfer();

  await expect(handle.finish()).rejects.toThrow('macOS runner recordStop rejected');
  await expect(handle.finish()).resolves.toMatchObject({ status: 'completed' });
  expect(calls).toEqual(['start', 'stop', 'stop']);
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
      outputs: { prepare },
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
