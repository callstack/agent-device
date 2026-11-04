import fs from 'node:fs';
import path from 'node:path';
import { expect, test, vi } from 'vitest';
import { runCmd } from '@agent-device/host-kit/command';
import { AppError } from '@agent-device/kernel/errors';
import { createTestHostEnvironment, mkdtempForTestSync } from '@agent-device/test-kit';
import { createVideoValidatorPreparation } from '@agent-device/capture-kit/recording-video';
import { mp4Atom, mp4MovieHeader } from '../packages/capture-kit/src/recording/mp4.fixtures.ts';
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
