import fs from 'node:fs';
import path from 'node:path';
import { expect, test, vi } from 'vitest';
import { runCmd } from '@agent-device/host-kit/command';
import { AppError } from '@agent-device/kernel/errors';
import { createTestHostEnvironment, mkdtempForTestSync } from '@agent-device/test-kit';
import {
  createVideoValidatorPreparation,
  isPlayableVideo,
} from '@agent-device/capture-kit/recording-video';
import { Deadline } from '@agent-device/host-kit/retry';
import { createApplicationResourceLifecycle } from './platform-runtime-application-resources.ts';
import type {
  AndroidApplicationTools,
  AppleApplicationTools,
} from '@agent-device/contracts/application-lifecycle-runtime';
import { mp4Atom, mp4MovieHeader } from '@agent-device/capture-kit/recording-mp4-fixtures';
import { createScreenRecordingFinalizer } from './platform-runtime-screen-recording-finalizer-host.ts';
import { createAppleApplicationTools } from './platform-runtime-apple-application-tools.ts';

vi.mock('@agent-device/host-kit/command', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@agent-device/host-kit/command')>()),
  runCmd: vi.fn(),
}));
vi.mock('@agent-device/platform-apple/runner/operations', () => ({
  prepareIosRunner: vi.fn(async () => ({
    runner: { currentUptimeMs: 42 },
    connectMs: 3,
    healthCheckMs: 3,
  })),
  prewarmIosRunnerSession: vi.fn(async () => {}),
}));

test('runner warmup preserves a compiler failure for recording stop', async () => {
  const originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform')!;
  Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true });
  const dir = mkdtempForTestSync('runner-validator-warm-');
  const host = createTestHostEnvironment({
    env: { ...process.env, AGENT_DEVICE_SWIFT_CACHE_DIR: dir },
  });
  const validator = createVideoValidatorPreparation(host);
  const finalizer = createScreenRecordingFinalizer(host, validator);
  const outputPath = path.join(dir, 'capture.mp4');
  fs.writeFileSync(
    outputPath,
    Buffer.concat([
      mp4Atom('ftyp', Buffer.from('isom', 'latin1')),
      mp4Atom(
        'moov',
        mp4Atom('mvhd', mp4MovieHeader({ version: 0, timescale: 1000, duration: 2000 })),
      ),
    ]),
  );
  vi.mocked(runCmd).mockRejectedValueOnce(new AppError('TOOL_MISSING', 'missing xcrun'));
  try {
    const tools = createAppleApplicationTools(host.env, finalizer.prepare);
    await expect(
      tools.prepareRunner(
        {
          platform: 'apple',
          appleOs: 'ios',
          id: 'sim-1',
          name: 'sim',
          kind: 'simulator',
          booted: true,
        },
        { timeoutMs: 10_000, execution: {} },
        new AbortController().signal,
      ),
    ).resolves.toMatchObject({ runner: { currentUptimeMs: 42 } });
    await expect.poll(() => vi.mocked(runCmd).mock.calls.length).toBe(1);
    await expect(
      finalizer.complete({
        outputPath,
        showTouches: false,
        gestureEvents: [],
        targetLabel: 'recording',
      }),
    ).rejects.toMatchObject({
      code: 'COMMAND_FAILED',
      details: { reason: 'video_validator_unavailable', retriable: false },
    });
    expect(runCmd).toHaveBeenCalledOnce();
  } finally {
    await validator.close();
    Object.defineProperty(process, 'platform', originalPlatform);
  }
});

test('recovery warming starts outside stop and a timed out read can retry the same compile', async () => {
  const originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform')!;
  Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true });
  const dir = mkdtempForTestSync('recovery-validator-warm-');
  const host = createTestHostEnvironment({
    env: { ...process.env, AGENT_DEVICE_SWIFT_CACHE_DIR: dir },
  });
  const validator = createVideoValidatorPreparation(host);
  const finalizer = createScreenRecordingFinalizer(host, validator);
  const resources = createApplicationResourceLifecycle({
    android: {} as AndroidApplicationTools,
    apple: {} as AppleApplicationTools,
    recording: { finalize: finalizer, closeValidatorPreparation: validator.close },
  });
  const outputPath = path.join(dir, 'capture.mp4');
  fs.writeFileSync(
    outputPath,
    Buffer.concat([
      mp4Atom('ftyp', Buffer.from('isom', 'latin1')),
      mp4Atom(
        'moov',
        mp4Atom('mvhd', mp4MovieHeader({ version: 0, timescale: 1000, duration: 2000 })),
      ),
    ]),
  );
  let finish!: () => void;
  vi.mocked(runCmd)
    .mockReset()
    .mockImplementationOnce(async (_cmd, args) => {
      await new Promise<void>((resolve) => {
        finish = resolve;
      });
      const executable = args[args.indexOf('-o') + 1]!;
      fs.writeFileSync(executable, 'validator');
      fs.chmodSync(executable, 0o755);
      return { exitCode: 0, stdout: '', stderr: '' };
    })
    .mockResolvedValue({ exitCode: 0, stdout: '', stderr: '' });
  try {
    await resources.prepareRecordingRecovery();
    await expect.poll(() => typeof finish).toBe('function');
    await expect(
      isPlayableVideo(outputPath, validator.read(), Deadline.fromTimeoutMs(5)),
    ).rejects.toMatchObject({
      details: { reason: 'video_validator_not_prepared', retriable: true },
    });
    expect(runCmd).toHaveBeenCalledOnce();
    finish();
    await expect(
      finalizer.complete({
        outputPath,
        showTouches: false,
        gestureEvents: [],
        targetLabel: 'recording',
      }),
    ).resolves.toHaveProperty('telemetryPath');
    expect(vi.mocked(runCmd).mock.calls.filter(([command]) => command === 'xcrun')).toHaveLength(1);
  } finally {
    finish?.();
    await validator.close();
    Object.defineProperty(process, 'platform', originalPlatform);
  }
});
