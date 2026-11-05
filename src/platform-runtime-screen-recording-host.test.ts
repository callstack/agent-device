import fs from 'node:fs';
import path from 'node:path';
import { afterEach, expect, test, vi } from 'vitest';
import { runCmd } from '@agent-device/host-kit/command';
import { AppError } from '@agent-device/kernel/errors';
import { localRuntimeOwner } from '@agent-device/contracts/platform-runtime';
import { createLiveTestHostEnvironment, mkdtempForTestSync } from '@agent-device/test-kit';
import * as video from '@agent-device/capture-kit/recording-video';
import { createAppleScreenRecordingOperations } from '../packages/platform-apple/src/recording/runtime.ts';
import {
  appleRecordingHost,
  coreDevice,
  recordingInput,
  simulator,
  simulatorRecorderStart,
} from '../packages/platform-apple/src/recording/runtime.fixtures.ts';
import { createScreenRecordingRuntimeHost } from './platform-runtime-screen-recording-host.ts';

vi.mock(import('@agent-device/host-kit/command'), async (importOriginal) => ({
  ...(await importOriginal()),
  runCmd: vi.fn(),
}));
afterEach(() => vi.restoreAllMocks());

function harness() {
  const root = mkdtempForTestSync('warm-video-validator-');
  const host = createScreenRecordingRuntimeHost({
    host: { ...createLiveTestHostEnvironment(), env: { AGENT_DEVICE_SWIFT_CACHE_DIR: root } },
  });
  return { host, input: recordingInput({ outputPath: path.join(root, 'capture.mp4') }) };
}

test.each([simulator, coreDevice])(
  'warms before $kind capture and starts while preparation is pending',
  async (device) => {
    const { host, input } = harness();
    let resolvePreparation!: (value: string) => void;
    const pending = new Promise<string>((resolve) => {
      resolvePreparation = resolve;
    });
    const preparation = vi.spyOn(video, 'prepareVideoValidator').mockReturnValue(pending);
    const launched = vi.fn(() => {
      expect(preparation).toHaveBeenCalledOnce();
      return {
        runnerSessionId: 'runner-session',
        runnerAuthority: 'local-lease' as const,
        remotePath: 'tmp/agent-device-recording-123.mp4',
      };
    });
    const fake = appleRecordingHost({
      apple: {
        ...simulatorRecorderStart(),
        runRunner: async () => launched(),
      },
    });
    const startSimulator = fake.screenRecording.apple.startSimulator;
    const operations = createAppleScreenRecordingOperations({
      host: {
        screenRecording: {
          ...fake.screenRecording,
          outputs: host.outputs,
          apple: {
            ...fake.screenRecording.apple,
            startSimulator: async (...args) => {
              launched();
              return await startSimulator(...args);
            },
          },
        },
      },
      device,
      owner: localRuntimeOwner('apple'),
      signal: new AbortController().signal,
    });
    let started = false;
    const starting = operations.screenRecordingStart(input).then((result) => {
      started = true;
      return result;
    });
    void starting.catch(() => {});
    try {
      await expect.poll(() => started, { timeout: 1_000 }).toBe(true);
      expect(launched).toHaveBeenCalledOnce();
    } finally {
      resolvePreparation('/bin/true');
      await starting;
    }
  },
);

test('a runCmd compile failure survives capture start and reaches the real stop finalizer', async () => {
  const { host, input } = harness();
  const failure = new AppError('COMMAND_FAILED', 'xcrun exited with code 72', {
    stderr: 'xcrun: error: unable to find utility "swiftc", not a developer tool or in PATH',
  });
  let rejectCompile!: (error: unknown) => void;
  const compile = new Promise<never>((_resolve, reject) => {
    rejectCompile = reject;
  });
  void compile.catch(() => {});
  vi.mocked(runCmd).mockClear().mockReturnValue(compile);
  const preparation = vi.spyOn(video, 'prepareVideoValidator');
  const fake = appleRecordingHost({
    apple: {
      retrieveRunnerRecording: async (_device, _remote, outputPath) => {
        fs.copyFileSync('website/docs/public/agent-device-contacts.mp4', outputPath);
      },
    },
  });
  const operations = createAppleScreenRecordingOperations({
    host: {
      screenRecording: { ...fake.screenRecording, outputs: host.outputs, finalize: host.finalize },
    },
    device: coreDevice,
    owner: localRuntimeOwner('apple'),
    signal: new AbortController().signal,
  });
  let captureStarted = false;
  const starting = operations.screenRecordingStart(input).then((result) => {
    captureStarted = true;
    return result;
  });
  try {
    await expect.poll(() => captureStarted, { timeout: 1_000 }).toBe(true);
    expect(preparation).toHaveBeenCalledOnce();
    await expect.poll(() => vi.mocked(runCmd).mock.calls.length).toBe(1);
  } finally {
    rejectCompile(failure);
    await starting;
  }
  const started = await starting;
  await expect(preparation.mock.results[0]!.value).rejects.toMatchObject({
    details: { reason: 'video_validator_unavailable' },
  });
  const handle = started.pendingHandle.transfer();
  await expect(handle.finish()).rejects.toMatchObject({
    code: 'COMMAND_FAILED',
    details: { reason: 'video_validator_unavailable', retriable: false },
    cause: failure,
  });
  expect(runCmd).toHaveBeenCalledExactlyOnceWith(
    'xcrun',
    expect.arrayContaining(['swiftc']),
    expect.any(Object),
  );
  expect(fs.existsSync(input.outputPath)).toBe(true);
});
