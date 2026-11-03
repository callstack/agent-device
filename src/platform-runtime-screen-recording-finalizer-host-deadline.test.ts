import fs from 'node:fs';
import path from 'node:path';
import { expect, test, vi } from 'vitest';
import { mkdtempForTestSync } from '@agent-device/test-kit';
import { runCmd } from '@agent-device/host-kit/command';
import { Deadline } from '@agent-device/host-kit/retry';
import { createRequestCanceledError } from '@agent-device/kernel/errors';
import { createVideoValidatorPreparation } from '@agent-device/capture-kit/recording-video';
import { createScreenRecordingFinalizer } from './platform-runtime-screen-recording-finalizer-host.ts';

vi.mock(import('@agent-device/host-kit/command'), async (importOriginal) => ({
  ...(await importOriginal()),
  runCmd: vi.fn(),
}));
vi.mock(import('@agent-device/capture-kit/recording-overlay'), async (importOriginal) => ({
  ...(await importOriginal()),
  startRecordingOverlayBudget: vi
    .fn()
    .mockImplementationOnce(() => Deadline.fromTimeoutMs(1))
    .mockImplementation(() => Deadline.fromTimeoutMs(10_000)),
}));

test('a finalizer deadline leaves the compiler running for a later stop', async () => {
  const platform = Object.getOwnPropertyDescriptor(process, 'platform')!;
  const root = mkdtempForTestSync('finalizer-validator-deadline-');
  const outputPath = path.join(root, 'recording.mp4');
  fs.writeFileSync(outputPath, Buffer.from('0000000c6674797069736f6d000000086d6f6f76', 'hex'));
  const host = {
    cwd: root,
    env: { ...process.env, AGENT_DEVICE_SWIFT_CACHE_DIR: path.join(root, 'cache') },
  };
  const preparation = createVideoValidatorPreparation(host);
  const finalizer = createScreenRecordingFinalizer(host, preparation);
  const input = { outputPath, showTouches: false, gestureEvents: [], targetLabel: 'recording' };
  let finishCompile: (() => void) | undefined;
  let compilerSignal: AbortSignal | undefined;
  let compiledPath = '';
  const compilerEntered = vi.fn();
  const validatorCalls: string[] = [];
  vi.mocked(runCmd).mockImplementation(async (command, args, options) => {
    if (command === 'xcrun') {
      compilerSignal = options?.signal;
      compiledPath = args[args.indexOf('-o') + 1]!;
      compilerEntered();
      await new Promise<void>((resolve, reject) => {
        const signal = options?.signal;
        const abort = () => reject(createRequestCanceledError());
        finishCompile = () => {
          signal?.removeEventListener('abort', abort);
          resolve();
        };
        if (signal?.aborted) abort();
        else signal?.addEventListener('abort', abort, { once: true });
      });
      fs.writeFileSync(compiledPath, 'validator');
      fs.chmodSync(compiledPath, 0o755);
    } else {
      validatorCalls.push(command);
    }
    return { exitCode: 0, stdout: '', stderr: '' };
  });
  Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true });
  try {
    await finalizer.prepare({ container: 'mp4' });
    await vi.waitFor(() => expect(compilerEntered).toHaveBeenCalledOnce(), { timeout: 1_000 });
    await expect(finalizer.complete(input)).rejects.toMatchObject({
      details: { reason: 'video_validator_not_prepared', retriable: true },
    });
    expect(compilerSignal?.aborted).toBe(false);
    expect(compilerEntered).toHaveBeenCalledOnce();
    expect(validatorCalls).toEqual([]);

    finishCompile!();
    await expect(finalizer.complete(input)).resolves.toEqual({ telemetryPath: expect.any(String) });
    expect(compilerSignal?.aborted).toBe(false);
    expect(compilerEntered).toHaveBeenCalledOnce();
    expect(validatorCalls).toEqual([
      path.join(path.dirname(path.dirname(compiledPath)), path.basename(compiledPath)),
    ]);
  } finally {
    finishCompile?.();
    try {
      await preparation.close();
    } finally {
      Object.defineProperty(process, 'platform', platform);
    }
  }
});
