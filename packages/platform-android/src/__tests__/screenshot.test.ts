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

test('screenshotAndroid waits for transient UI to settle before capture', async () => {
  const events: string[] = [];
  await withTempScreenshot('screenshot-settle-', async (outPath) => {
    mockScreenshotEvents(events);
    await screenshotAndroid(device, outPath);

    const relevantEvents = events.filter((event, index) => {
      if (event !== 'enable') {
        return true;
      }
      return index === 0;
    });
    assert.deepEqual(relevantEvents, ['enable', 'settle:1000', 'capture', 'disable']);
  });
});

test('screenshotAndroid skips stabilization when requested', async () => {
  const events: string[] = [];
  await withTempScreenshot('screenshot-stabilize-', async (outPath) => {
    mockScreenshotEvents(events);
    await screenshotAndroid(device, outPath, { stabilize: false });

    assert.deepEqual(events, ['capture']);
    assert.equal(mockSleep.mock.calls.length, 0);
  });
});

test('screenshotAndroid writes a valid PNG when output is clean', async () => {
  await withTempScreenshot('screenshot-clean-', async (outPath) => {
    await screenshotAndroid(device, outPath);
    const written = await fs.readFile(outPath);
    assert.deepEqual(written, VALID_PNG);
  });
});

test('screenshotAndroid strips warning text before PNG signature', async () => {
  const warning =
    '[Warning] Multiple displays were found, but no display id was specified! Defaulting to the first display found.';
  mockScreenshotPayload(Buffer.concat([Buffer.from(warning), VALID_PNG]));

  await withTempScreenshot('screenshot-warning-', async (outPath) => {
    await screenshotAndroid(device, outPath);
    const written = await fs.readFile(outPath);
    assert.deepEqual(written, VALID_PNG);
  });
});

test('screenshotAndroid strips trailing garbage after PNG payload', async () => {
  mockScreenshotPayload(Buffer.concat([VALID_PNG, Buffer.from('\ntrailing-warning\n')]));

  await withTempScreenshot('screenshot-trailing-', async (outPath) => {
    await screenshotAndroid(device, outPath);
    const written = await fs.readFile(outPath);
    assert.deepEqual(written, VALID_PNG);
  });
});

test('screenshotAndroid throws when output contains no PNG signature', async () => {
  mockScreenshotPayload(Buffer.from('not a png'));

  await withTempScreenshot('screenshot-nopng-', async (outPath) => {
    await assert.rejects(() => screenshotAndroid(device, outPath), {
      message: 'Screenshot data does not contain a valid PNG header',
    });
  });
});

test('screenshotAndroid throws when PNG payload is truncated', async () => {
  mockScreenshotPayload(VALID_PNG.subarray(0, VALID_PNG.length - 3));

  await withTempScreenshot('screenshot-truncated-', async (outPath) => {
    await assert.rejects(() => screenshotAndroid(device, outPath), {
      message: 'Screenshot data does not contain a complete PNG payload',
    });
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
  mockRunCmd.mockImplementation(async (_cmd, args) => {
    if (args.includes('exec-out')) {
      return { exitCode: 0, stdout: '', stderr: '', stdoutBuffer: VALID_PNG };
    }
    if (args.includes('dumpsys')) return await new Promise<never>(() => {});
    return { exitCode: 0, stdout: '', stderr: '' };
  });

  await withTempScreenshot('screenshot-display-rotation-hung-', async (outPath) => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      let facts: Awaited<ReturnType<typeof screenshotAndroid>> | undefined;
      const capture = screenshotAndroid(device, outPath, { stabilize: false }).then((result) => {
        facts = result;
      });
      // The capture writes through real file I/O, so the grace timer starts at an unknown turn:
      // yield to I/O, then advance the fake clock, until the screenshot settles.
      for (let turn = 0; turn < 100 && facts === undefined; turn++) {
        await new Promise((resolve) => setImmediate(resolve));
        await vi.advanceTimersByTimeAsync(250);
      }
      await capture;
      assert.deepEqual(facts, {});
    } finally {
      vi.useRealTimers();
    }
  });
});

function mockScreenshotEvents(events: string[]): void {
  mockRunCmd.mockImplementation(async (_cmd, args) => {
    if (args.includes('exec-out')) {
      events.push('capture');
      return { exitCode: 0, stdout: '', stderr: '', stdoutBuffer: VALID_PNG };
    }
    if (args.includes('dumpsys')) return { exitCode: 0, stdout: '', stderr: '' };
    events.push(args.some((arg) => arg.includes('exit')) ? 'disable' : 'enable');
    return { exitCode: 0, stdout: '', stderr: '' };
  });
  mockSleep.mockImplementation(async (ms) => {
    events.push(`settle:${ms}`);
  });
}

function mockScreenshotPayload(payload: Buffer): void {
  mockRunCmd.mockImplementation(async (_cmd, args) => {
    if (args.includes('exec-out')) {
      return { exitCode: 0, stdout: '', stderr: '', stdoutBuffer: payload };
    }
    return { exitCode: 0, stdout: '', stderr: '' };
  });
}

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
