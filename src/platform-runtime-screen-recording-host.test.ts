import fs from 'node:fs';
import path from 'node:path';
import { afterEach, expect, test, vi } from 'vitest';
import { runCmd } from '@agent-device/host-kit/command';
import { AppError } from '@agent-device/kernel/errors';
import type { DeviceInfo } from '@agent-device/kernel/device';
import { createLiveTestHostEnvironment, mkdtempForTestSync } from '@agent-device/test-kit';
import * as video from '@agent-device/capture-kit/recording-video';
import { runtimeModule } from '@agent-device/platform-apple';
import { createPlatformRuntimeHost } from './platform-runtime-operation-host.ts';

const devices: DeviceInfo[] = ['simulator', 'device'].map((kind) => ({
  platform: 'apple',
  appleOs: 'ios',
  id: kind,
  name: kind,
  kind: kind as 'simulator' | 'device',
  target: 'mobile',
  booted: true,
  ...(kind === 'device' ? { iosPhysicalDeviceBackend: 'coredevice' as const } : {}),
}));

vi.mock(import('@agent-device/host-kit/command'), async (importOriginal) => ({
  ...(await importOriginal()),
  runCmd: vi.fn(),
}));
afterEach(() => vi.restoreAllMocks());

async function harness(device: DeviceInfo, launch = () => {}) {
  const root = mkdtempForTestSync('warm-video-validator-');
  const unused = async (): Promise<never> => {
    throw new Error('unused');
  };
  const host = createPlatformRuntimeHost({
    host: { ...createLiveTestHostEnvironment(), env: { AGENT_DEVICE_SWIFT_CACHE_DIR: root } },
    sessionsDir: root,
    resolveSessionArtifacts: () => {
      throw new Error('unused');
    },
    snapshot: { captureSurface: unused, presentIosAcquisition: unused },
    shutdownLoaders: { apple: unused, android: unused },
  });
  const runtime = await runtimeModule.loadRuntime({
    ...host,
    screenRecording: {
      ...host.screenRecording,
      apple: {
        ...host.screenRecording.apple,
        availability: async () => ({ available: true }),
        isRunnerBundleId: async () => false,
        captureClockAnchor: async () => undefined,
        startSimulator: async () => {
          launch();
          return {
            markers: [{ pid: 42, startTime: 'start', command: 'recorder' }],
            wait: new Promise<never>(() => {}),
            terminate: async () => {},
          };
        },
        runRunner: async (_device, request) => {
          if (request.kind !== 'start') return {};
          launch();
          return {
            runnerSessionId: 'runner',
            runnerAuthority: 'local-lease',
            remotePath: 'tmp/agent-device-recording-123.mp4',
          };
        },
        retrieveRunnerRecording: async (_device, _remote, outputPath) => {
          fs.copyFileSync('website/docs/public/agent-device-contacts.mp4', outputPath);
        },
      },
    },
  });
  const binding = await runtime.bind({
    device,
    intent: { kind: 'ordinary' },
    scope: {
      signal: new AbortController().signal,
      diagnostics: { emit: () => {} },
      progress: { report: () => {} },
    },
  });
  const input = {
    sessionId: 'one',
    outputPath: path.join(root, 'capture.mp4'),
    scope: 'device' as const,
    showTouches: false,
    hideTouchesRequested: false,
    recordOnlySession: false,
    activeSessionApp: { bundleId: 'com.example.app' },
    fence: { token: 'fence', generation: 1 },
  };
  return { input, start: () => binding.operations.screenRecordingStart!(input) };
}

test.each(devices)(
  'warms before $kind capture and starts while preparation is pending',
  async (device) => {
    let resolvePreparation!: (value: string) => void;
    const pending = new Promise<string>((resolve) => {
      resolvePreparation = resolve;
    });
    const preparation = vi.spyOn(video, 'prepareVideoValidator').mockReturnValue(pending);
    const launched = vi.fn(() => {
      expect(preparation).toHaveBeenCalledOnce();
    });
    const { start } = await harness(device, launched);
    let started = false;
    const starting = start().then((result) => {
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
  const { start, input } = await harness(devices[1]!);
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
  let captureStarted = false;
  const starting = start().then((result) => {
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
