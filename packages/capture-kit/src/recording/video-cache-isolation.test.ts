import fs from 'node:fs';
import path from 'node:path';
import { afterEach, expect, test, vi } from 'vitest';
import { runCmd } from '@agent-device/host-kit/command';
import { createTestHost } from '../host-environment.fixtures.ts';
import { mkdtempForTestSync } from '../tmp-dir.fixtures.ts';
import { createVideoValidatorPreparation } from './video.ts';

vi.mock(import('@agent-device/host-kit/command'), async (importOriginal) => ({
  ...(await importOriginal()),
  runCmd: vi.fn(),
}));

const originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform')!;
afterEach(() => {
  Object.defineProperty(process, 'platform', originalPlatform);
  vi.restoreAllMocks();
});

async function runIsolationScenario(failBeforeClose: boolean, stallClose = false): Promise<void> {
  Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true });
  const cacheDir = mkdtempForTestSync('video-cache-isolation-');
  const host = {
    ...createTestHost(),
    env: { ...process.env, AGENT_DEVICE_SWIFT_CACHE_DIR: cacheDir },
  };
  const first = createVideoValidatorPreparation(host);
  const second = createVideoValidatorPreparation(host);
  const signals: AbortSignal[] = [];
  let finishSecond!: () => void;
  let releaseSecond = false;
  vi.mocked(runCmd).mockImplementation(async (_command, args, options) => {
    const signal = options!.signal!;
    signals.push(signal);
    await new Promise<void>((resolve, reject) => {
      const abort = () => {
        signal.removeEventListener('abort', abort);
        reject(new Error('compiler cancelled'));
      };
      const finish = () => {
        signal.removeEventListener('abort', abort);
        resolve();
      };
      if (signal.aborted) {
        abort();
      } else {
        signal.addEventListener('abort', abort, { once: true });
        if (signals.length > 1) {
          finishSecond = finish;
          if (releaseSecond) finish();
        }
      }
    });
    const output = args[args.indexOf('-o') + 1]!;
    fs.writeFileSync(output, 'compiled');
    fs.chmodSync(output, 0o755);
    return { exitCode: 0, stdout: '', stderr: '' };
  });
  const firstResult = first.prepare();
  void firstResult.catch(() => undefined);
  let secondResult: ReturnType<typeof second.prepare> | undefined;
  let earlyFailureReached = false;
  try {
    await expect.poll(() => signals.length, { timeout: 5_000 }).toBe(1);
    const bin = path.join(cacheDir, 'bin');
    const lock = fs.readdirSync(bin).find((entry) => entry.endsWith('.lock'))!;
    expect(lock).toBeTruthy();
    const read = vi.spyOn(fs, 'readFileSync');
    secondResult = second.prepare();
    void secondResult.catch(() => undefined);
    await expect
      .poll(() => read.mock.calls.some(([file]) => String(file).startsWith(path.join(bin, lock))), {
        timeout: 5_000,
      })
      .toBe(true);
    expect(signals).toHaveLength(1);
    if (failBeforeClose) {
      earlyFailureReached = true;
      throw new Error('intentional early assertion failure');
    }
    await first.close();
    expect(signals[0]!.aborted).toBe(true);
    await expect(firstResult).rejects.toThrow('compiler cancelled');
    await expect.poll(() => signals.length, { timeout: 5_000 }).toBe(2);
    expect(signals[1]!.aborted).toBe(false);
    finishSecond();
    const result = await secondResult;
    expect(result.kind).toBe('avfoundation');
    expect(await second.read()).toEqual(result);
    const warm = createVideoValidatorPreparation(host);
    expect(await warm.prepare()).toEqual(result);
    await warm.close();
    expect(signals).toHaveLength(2);
    expect(
      fs.readdirSync(bin).some((entry) => entry.endsWith('.lock') || entry.startsWith('.')),
    ).toBe(false);
  } finally {
    try {
      finishSecond?.();
      await first.close();
      if (earlyFailureReached) await expect.poll(() => signals.length, { timeout: 5_000 }).toBe(2);
    } finally {
      try {
        const close = second.close();
        const closing = stallClose ? close.then(() => new Promise<void>(() => {})) : close;
        let timeout: ReturnType<typeof setTimeout> | undefined;
        try {
          await Promise.race([
            closing,
            new Promise<never>((_resolve, reject) => {
              timeout = setTimeout(
                () => reject(new Error('second owner cleanup did not settle')),
                1_000,
              );
            }),
          ]);
        } finally {
          clearTimeout(timeout);
          releaseSecond = true;
          finishSecond?.();
        }
      } finally {
        await Promise.allSettled([firstResult, ...(secondResult ? [secondResult] : [])]);
        try {
          const bin = path.join(cacheDir, 'bin');
          if (fs.existsSync(bin)) {
            expect(
              fs.readdirSync(bin).some((entry) => entry.endsWith('.lock') || entry.startsWith('.')),
            ).toBe(false);
          }
        } finally {
          fs.rmSync(cacheDir, { recursive: true, force: true });
        }
      }
    }
  }
}

test('closing a cache lock holder lets another pending owner compile and publish', async () => {
  await runIsolationScenario(false);
}, 15_000);

test('cleanup cancels a compiler that starts after an early failure', async () => {
  await expect(runIsolationScenario(true)).rejects.toThrow('intentional early assertion failure');
}, 15_000);

test('cleanup reports a close that never settles and removes its cache', async () => {
  const remove = vi.spyOn(fs, 'rmSync');
  await expect(runIsolationScenario(true, true)).rejects.toThrow(
    'second owner cleanup did not settle',
  );
  const cache = remove.mock.calls
    .map(([file]) => String(file))
    .find((file) => path.basename(file).startsWith('video-cache-isolation-'));
  expect(cache).toBeDefined();
  expect(fs.existsSync(cache!)).toBe(false);
}, 10_000);
