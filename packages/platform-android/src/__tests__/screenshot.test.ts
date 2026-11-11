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
import * as diagnostics from '@agent-device/host-kit/diagnostics';

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

test('Android screenshots capture immediately by default and stabilize only when requested', async () => {
  await withTempScreenshot('screenshot-default-latency-', async (outPath) => {
    await screenshotAndroid(device, outPath);
    assert.equal(mockSleep.mock.calls.length, 0);
    assert.equal(
      mockRunCmd.mock.calls.some(([, args]) => args.includes('broadcast')),
      false,
    );
    assert.deepEqual(await fs.readFile(outPath), VALID_PNG);
    await screenshotAndroid(device, outPath, { normalizeStatusBar: true });
    assert.deepEqual(mockSleep.mock.calls, [[1000]]);
    assert.equal(
      mockRunCmd.mock.calls.some(([, args]) => args.includes('broadcast')),
      true,
    );
  });
});

for (const initial of [undefined, '0', '1', 'custom=value'] as const) {
  for (const outcome of ['success', 'capture failure', 'cancellation'] as const) {
    test(`stabilized screenshot restores ${initial ?? 'absent'} after ${outcome}`, async () => {
      let setting: string | undefined = initial;
      const primary = new Error(outcome);
      mockRunCmd.mockImplementation(async (_cmd, args) => {
        if (args.includes('settings')) {
          if (args.includes('list')) {
            return {
              exitCode: 0,
              stdout: setting === undefined ? '' : `sysui_demo_allowed=${setting}\n`,
              stderr: '',
            };
          }
          if (args.includes('get')) return { exitCode: 0, stdout: `${setting}\n`, stderr: '' };
          if (args.includes('delete')) setting = undefined;
          if (args.includes('put')) setting = args.at(-1);
        }
        if (args.includes('exec-out')) {
          if (outcome === 'capture failure') throw primary;
          return { exitCode: 0, stdout: '', stderr: '', stdoutBuffer: VALID_PNG };
        }
        return { exitCode: 0, stdout: '', stderr: '' };
      });
      if (outcome === 'cancellation') mockSleep.mockRejectedValue(primary);
      await withTempScreenshot('screenshot-restore-', async (outPath) => {
        if (outcome === 'success') await screenshotAndroid(device, outPath, { stabilize: true });
        else
          await assert.rejects(
            screenshotAndroid(device, outPath, { stabilize: true }),
            (error) => error === primary,
          );
        assert.equal(setting, initial);
      });
    });
  }
}

test('failed prior setting read does not mutate demo mode', async () => {
  mockRunCmd.mockImplementation(async (_cmd, args) => {
    if (args.includes('settings') && args.includes('list'))
      return { exitCode: 1, stdout: '', stderr: 'read failed' };
    throw new Error('unexpected command');
  });
  await withTempScreenshot('screenshot-read-failure-', async (outPath) => {
    await assert.rejects(screenshotAndroid(device, outPath, { stabilize: true }), {
      code: 'COMMAND_FAILED',
    });
    assert.equal(mockRunCmd.mock.calls.length, 1);
  });
});

test('restoration failure surfaces after a successful capture', async () => {
  mockRunCmd.mockImplementation(async (_cmd, args) => {
    if (args.includes('settings') && args.includes('delete'))
      return { exitCode: 1, stdout: '', stderr: 'restore failed' };
    if (args.includes('exec-out'))
      return { exitCode: 0, stdout: '', stderr: '', stdoutBuffer: VALID_PNG };
    return { exitCode: 0, stdout: '', stderr: '' };
  });
  await withTempScreenshot('screenshot-restore-failure-', async (outPath) => {
    await assert.rejects(screenshotAndroid(device, outPath, { stabilize: true }), {
      code: 'COMMAND_FAILED',
    });
  });
});

test('restoration failure is diagnostic evidence when capture fails', async () => {
  const primary = new Error('capture failed');
  const cleanup = new Error('restore failed');
  const diagnostic = vi.spyOn(diagnostics, 'emitDiagnostic');
  mockRunCmd.mockImplementation(async (_cmd, args) => {
    if (args.includes('settings') && args.includes('delete')) throw cleanup;
    if (args.includes('exec-out')) throw primary;
    return { exitCode: 0, stdout: '', stderr: '' };
  });
  try {
    await withTempScreenshot('screenshot-both-fail-', async (outPath) => {
      await assert.rejects(
        screenshotAndroid(device, outPath, { stabilize: true }),
        (error) => error === primary,
      );
      assert.equal(
        diagnostic.mock.calls.some(
          ([event]) => event.phase === 'android_screenshot_demo_setting_restore_failed',
        ),
        true,
      );
    });
  } finally {
    diagnostic.mockRestore();
  }
});
