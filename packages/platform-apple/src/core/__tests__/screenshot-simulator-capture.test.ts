import { beforeEach, test, vi } from 'vitest';
import assert from 'node:assert/strict';
import { promises as fs, writeFileSync } from 'node:fs';
import path from 'node:path';
import { mkdtempForTest } from '../../__tests__/tmp-dir.ts';

vi.mock('@agent-device/host-kit/retry', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@agent-device/host-kit/retry')>();
  return { ...actual, retryWithPolicy: vi.fn(actual.retryWithPolicy) };
});

const retryActual = await vi.importActual<typeof import('@agent-device/host-kit/retry')>(
  '@agent-device/host-kit/retry',
);

import { screenshotIos } from '../screenshot.ts';
import { retryWithPolicy } from '@agent-device/host-kit/retry';
import { PNG } from '@agent-device/capture-kit/png';
import { withFakeAppleTool, type FakeAppleToolResponse } from '../../__tests__/fake-apple-tool.ts';
import { IOS_TEST_SIMULATOR } from './apple-core-stub-helpers.ts';

const mockRetryWithPolicy = vi.mocked(retryWithPolicy);

beforeEach(() => {
  vi.resetAllMocks();
  mockRetryWithPolicy.mockImplementation(retryActual.retryWithPolicy);
});

const BOOTED_SIM_LIST_JSON = JSON.stringify({
  devices: { 'com.apple.CoreSimulator.SimRuntime.iOS-18-0': [{ udid: 'sim-1', state: 'Booted' }] },
});

function isSimctlListDevices(args: string[]): boolean {
  return (
    args[0] === 'simctl' && args.includes('list') && args.includes('devices') && args.includes('-j')
  );
}

function unexpectedArgs(args: string[]): FakeAppleToolResponse {
  return { stderr: `unexpected xcrun args: ${args.join(' ')}`, exitCode: 1 };
}

function isSimctlMainScreenScale(args: string[]): boolean {
  return args[0] === 'simctl' && args[1] === 'getenv' && args[3] === 'SIMULATOR_MAINSCREEN_SCALE';
}

function isSimctlScreenshot(args: string[]): boolean {
  return (
    args[0] === 'simctl' && args[1] === 'io' && args[2] === 'sim-1' && args[3] === 'screenshot'
  );
}

test('screenshotIos retries simulator capture timeouts and eventually succeeds', async () => {
  const tmpDir = await mkdtempForTest('agent-device-ios-screenshot-retry-test-');
  const outPath = path.join(tmpDir, 'screen.png');

  // Dimensions divisible by 3 so the implicit density-1 rescale (against the stub's native
  // scale 3) stays exact. This test is about capture retry, not resolution, so the source is
  // small rather than the 1206x2622 iPhone 16 Pro frame it used to allocate and resize —
  // 3.2 megapixels to prove arithmetic that 34k pixels prove just as well.
  const sourcePng = PNG.sync.write(new PNG({ width: 126, height: 273 }));

  mockRetryWithPolicy.mockImplementation(async (fn, policy, options) => {
    assert.ok(policy);
    assert.ok(options);
    assert.equal(options.phase, 'ios_simulator_screenshot');
    assert.equal(policy.maxAttempts, 5);
    assert.equal(policy.baseDelayMs, 1_000);
    assert.equal(policy.maxDelayMs, 5_000);
    let lastError: unknown;
    for (let attempt = 1; attempt <= policy.maxAttempts; attempt += 1) {
      try {
        return await fn({
          attempt,
          maxAttempts: policy.maxAttempts,
          deadline: options.deadline,
        });
      } catch (error) {
        lastError = error;
        if (!policy.shouldRetry?.(error, attempt)) throw error;
      }
    }
    throw lastError;
  });

  let screenshotAttempts = 0;
  await withFakeAppleTool(
    (args) => {
      if (isSimctlListDevices(args)) return BOOTED_SIM_LIST_JSON;
      if (isSimctlMainScreenScale(args)) return '3\n';
      if (isSimctlScreenshot(args)) {
        screenshotAttempts += 1;
        if (screenshotAttempts < 3) {
          return {
            stderr: 'Detected file type from extension: PNG\nTimeout waiting for screen surfaces\n',
            exitCode: 60,
          };
        }
        writeFileSync(args[4] ?? '', sourcePng);
        return '';
      }
      return unexpectedArgs(args);
    },
    async ({ calls }) => {
      await screenshotIos(IOS_TEST_SIMULATOR, outPath, { env: process.env });
      const png = PNG.sync.read(await fs.readFile(outPath));
      assert.equal(png.width, 42);
      assert.equal(png.height, 91);
      assert.equal(screenshotAttempts, 3);

      const flat = calls.map((args) => args.join(' '));
      assert.equal(
        flat.filter((line) => line === `simctl io sim-1 screenshot ${outPath}`).length,
        3,
        'should retry screenshot command until success',
      );
      assert.deepEqual(
        calls.filter((args) => args[0] === 'open'),
        [],
        'should not focus simulator host app while retrying screenshots',
      );
    },
  );
});

test('screenshotIos keeps requested simulator pixel density', async () => {
  const tmpDir = await mkdtempForTest('agent-device-ios-screenshot-density-');
  const outPath = path.join(tmpDir, 'screen.png');

  // Both dimensions divisible by 3 so the 2/3 rescale (density 2 against the stub's native
  // scale 3) stays exact. What this pins is that ratio, not an absolute resolution: it used
  // to allocate and resize a 1206x2622 iPhone 16 Pro frame — 3.2 megapixels, ~90x more than
  // the arithmetic needs.
  const sourcePng = PNG.sync.write(new PNG({ width: 126, height: 273 }));

  await withFakeAppleTool(
    (args) => {
      if (isSimctlListDevices(args)) return BOOTED_SIM_LIST_JSON;
      if (isSimctlMainScreenScale(args)) return '3\n';
      if (isSimctlScreenshot(args)) {
        writeFileSync(args[4] ?? '', sourcePng);
        return '';
      }
      return unexpectedArgs(args);
    },
    async () => {
      await screenshotIos(IOS_TEST_SIMULATOR, outPath, { env: process.env, pixelDensity: 2 });
      const png = PNG.sync.read(await fs.readFile(outPath));
      assert.equal(png.width, 84);
      assert.equal(png.height, 182);
    },
  );
});
