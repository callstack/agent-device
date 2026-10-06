import { beforeEach, test, vi } from 'vitest';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';

vi.mock('@agent-device/host-kit/command', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@agent-device/host-kit/command')>();
  return { ...actual, runCmd: vi.fn() };
});
vi.mock('../adb.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../adb.ts')>();
  return { ...actual, sleep: vi.fn() };
});

import { mkdtempForTest } from './test-utils/android-host-test-setup.ts';
import { screenshotAndroid } from '../screenshot.ts';
import type { DeviceInfo } from '@agent-device/kernel/device';
import { runCmd } from '@agent-device/host-kit/command';
import { sleep } from '../adb.ts';

const VALID_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+b9xkAAAAASUVORK5CYII=',
  'base64',
);
const mockRunCmd = vi.mocked(runCmd);
const mockSleep = vi.mocked(sleep);

const device: DeviceInfo = {
  platform: 'android',
  id: 'emulator-5554',
  name: 'Pixel',
  kind: 'emulator',
  booted: true,
};

beforeEach(() => {
  mockRunCmd.mockReset();
  mockSleep.mockReset();
  mockSleep.mockResolvedValue(undefined);
  mockRunCmd.mockImplementation(async (_cmd, args) => {
    if (args.includes('exec-out')) {
      return { exitCode: 0, stdout: '', stderr: '', stdoutBuffer: VALID_PNG };
    }
    return { exitCode: 0, stdout: '', stderr: '' };
  });
});

test('screenshotAndroid reports the display rotation read beside the capture', async () => {
  mockRunCmd.mockImplementation(async (_cmd, args) => {
    if (args.includes('exec-out')) {
      return { exitCode: 0, stdout: '', stderr: '', stdoutBuffer: VALID_PNG };
    }
    if (args.includes('dumpsys') && args.includes('display')) {
      return { exitCode: 0, stdout: '  mCurrentOrientation=3\n', stderr: '' };
    }
    return { exitCode: 0, stdout: '', stderr: '' };
  });

  await withTempScreenshot('screenshot-display-rotation-', async (outPath) => {
    assert.deepEqual(await screenshotAndroid(device, outPath, { stabilize: false }), {
      displayRotation: 'landscape-right',
    });
  });
});

test('screenshotAndroid still captures when the display rotation read fails', async () => {
  mockRunCmd.mockImplementation(async (_cmd, args) => {
    if (args.includes('exec-out')) {
      return { exitCode: 0, stdout: '', stderr: '', stdoutBuffer: VALID_PNG };
    }
    if (args.includes('dumpsys')) throw new Error('adb shell dumpsys display timed out');
    return { exitCode: 0, stdout: '', stderr: '' };
  });

  await withTempScreenshot('screenshot-display-rotation-failed-', async (outPath) => {
    assert.deepEqual(await screenshotAndroid(device, outPath, { stabilize: false }), {});
    assert.deepEqual(await fs.readFile(outPath), VALID_PNG);
  });
});

test('screenshotAndroid drops a display rotation probe still running after the capture', async () => {
  let probeSignal: AbortSignal | undefined;
  mockRunCmd.mockImplementation(async (_cmd, args, options) => {
    if (args.includes('exec-out')) {
      return { exitCode: 0, stdout: '', stderr: '', stdoutBuffer: VALID_PNG };
    }
    if (args.includes('dumpsys')) {
      probeSignal = options?.signal;
      return await new Promise<never>(() => {});
    }
    return { exitCode: 0, stdout: '', stderr: '' };
  });

  await withTempScreenshot('screenshot-display-rotation-hung-', async (outPath) => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      let facts: Awaited<ReturnType<typeof screenshotAndroid>> | undefined;
      const capture = screenshotAndroid(device, outPath, { stabilize: false }).then((result) => {
        facts = result;
      });
      // The image is written through real file I/O; the only timer this path installs is the
      // grace that starts once the write is done. Yield to I/O until it exists, bounded by wall
      // time because a loaded thread pool can take any number of event-loop turns to finish it.
      const writeDeadline = performance.now() + 10_000;
      while (vi.getTimerCount() === 0 && performance.now() < writeDeadline) {
        await new Promise((resolve) => setImmediate(resolve));
      }
      assert.equal(vi.getTimerCount(), 1, 'the capture must start one grace timer once written');
      assert.equal(facts, undefined, 'the screenshot waits for the probe until the grace ends');
      await vi.runOnlyPendingTimersAsync();
      await capture;
      assert.deepEqual(facts, {});
      assert.equal(probeSignal?.aborted, true, 'no adb probe may outlive the screenshot');
    } finally {
      vi.useRealTimers();
    }
  });
});

async function withTempScreenshot(
  name: string,
  callback: (outPath: string) => Promise<void>,
): Promise<void> {
  const tmpDir = await mkdtempForTest(name);
  try {
    await callback(path.join(tmpDir, 'out.png'));
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
}
