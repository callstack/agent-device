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

test('closing a cache lock holder lets another pending owner compile and publish', async () => {
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
  vi.mocked(runCmd).mockImplementation(async (_command, args, options) => {
    const signal = options!.signal!;
    signals.push(signal);
    if (signals.length === 1) {
      await new Promise<void>((_resolve, reject) => {
        signal.addEventListener('abort', () => reject(new Error('compiler cancelled')), {
          once: true,
        });
      });
    } else {
      await new Promise<void>((resolve) => {
        finishSecond = resolve;
      });
      const output = args[args.indexOf('-o') + 1]!;
      fs.writeFileSync(output, 'compiled');
      fs.chmodSync(output, 0o755);
    }
    return { exitCode: 0, stdout: '', stderr: '' };
  });
  const firstResult = first.prepare();
  void firstResult.catch(() => undefined);
  let secondResult: ReturnType<typeof second.prepare> | undefined;
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
    finishSecond?.();
    await first.close();
    await second.close();
    await secondResult?.catch(() => undefined);
    fs.rmSync(cacheDir, { recursive: true, force: true });
  }
}, 15_000);
