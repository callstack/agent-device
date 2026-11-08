import { beforeEach, test, vi } from 'vitest';
import assert from 'node:assert/strict';
import { promises as fs, readFileSync } from 'node:fs';
import path from 'node:path';
import type { RunnerScreenCaptureMetadata } from '@agent-device/contracts/screen-capture-contract';
import { bindTestCommandHost } from '@agent-device/test-kit';
import { mkdtempForTest } from '../../__tests__/tmp-dir.ts';

bindTestCommandHost();

vi.mock('@agent-device/host-kit/command', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@agent-device/host-kit/command')>();
  return { ...actual, runCmd: vi.fn(actual.runCmd) };
});
vi.mock('@agent-device/host-kit/retry', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@agent-device/host-kit/retry')>();
  return { ...actual, retryWithPolicy: vi.fn(actual.retryWithPolicy) };
});
vi.mock('../runner-client.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../runner-client.ts')>();
  return { ...actual, runAppleRunnerCommand: vi.fn(actual.runAppleRunnerCommand) };
});
vi.mock('../simulator.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../simulator.ts')>();
  return {
    ...actual,
    ensureBootedSimulator: vi.fn(actual.ensureBootedSimulator),
    openIosSimulatorApp: vi.fn(actual.openIosSimulatorApp),
  };
});
vi.mock('../screenshot-status-bar.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../screenshot-status-bar.ts')>();
  return {
    ...actual,
    withNormalizedSimulatorStatusBar: vi.fn(actual.withNormalizedSimulatorStatusBar),
  };
});

const execActual = await vi.importActual<typeof import('@agent-device/host-kit/command')>(
  '@agent-device/host-kit/command',
);
const retryActual = await vi.importActual<typeof import('@agent-device/host-kit/retry')>(
  '@agent-device/host-kit/retry',
);
const runnerActual =
  await vi.importActual<typeof import('../runner-client.ts')>('../runner-client.ts');
const simulatorActual = await vi.importActual<typeof import('../simulator.ts')>('../simulator.ts');
import {
  captureSimulatorScreenshotWithFallback,
  captureSimulatorScreenshotWithRetry,
  captureScreenshotViaRunner,
  screenshotIos,
  resolveRunnerScreenshotFilePaths,
  shouldRetryIosSimulatorScreenshot,
} from '../screenshot.ts';
import { ensureBootedSimulator, openIosSimulatorApp } from '../simulator.ts';
import {
  invalidateSimulatorStatusBarOverrideCache,
  withNormalizedSimulatorStatusBar,
  withSimulatorStatusBarHeld,
} from '../screenshot-status-bar.ts';
import { runAppleRunnerCommand } from '../runner-client.ts';
import { runCmd } from '@agent-device/host-kit/command';
import { withDiagnosticsScope } from '@agent-device/host-kit/diagnostics';
import { retryWithPolicy } from '@agent-device/host-kit/retry';
import { AppError } from '@agent-device/kernel/errors';
import { resolveAppleToolProvider, withAppleToolProvider } from '../tool-provider.ts';

import { IOS_TEST_SIMULATOR, MACOS_TEST_DEVICE } from './apple-core-stub-helpers.ts';

const mockRunCmd = vi.mocked(runCmd);
const mockRetryWithPolicy = vi.mocked(retryWithPolicy);
const mockRunAppleRunnerCommand = vi.mocked(runAppleRunnerCommand);
const mockEnsureBootedSimulator = vi.mocked(ensureBootedSimulator);
const mockOpenIosSimulatorApp = vi.mocked(openIosSimulatorApp);
const mockWithNormalizedStatusBar = vi.mocked(withNormalizedSimulatorStatusBar);

// The wire key and a real measured capture come from the cross-language golden table, so this
// consumer suite cannot spell a shape the Swift encoder disagrees with (#2728).
const SCREEN_CAPTURE_TABLE = JSON.parse(
  readFileSync(
    new URL('../../../../../contracts/fixtures/screen-capture-metadata.json', import.meta.url),
    'utf8',
  ),
) as { key: string; captures: Array<{ metadata: RunnerScreenCaptureMetadata }> };
const [MEASURED_CAPTURE] = SCREEN_CAPTURE_TABLE.captures;
assert(MEASURED_CAPTURE, 'the golden table must record at least one measured capture');

beforeEach(() => {
  vi.resetAllMocks();
  mockRunCmd.mockImplementation(execActual.runCmd);
  mockRetryWithPolicy.mockImplementation(retryActual.retryWithPolicy);
  mockRunAppleRunnerCommand.mockImplementation(runnerActual.runAppleRunnerCommand);
  mockEnsureBootedSimulator.mockImplementation(simulatorActual.ensureBootedSimulator);
  mockOpenIosSimulatorApp.mockImplementation(simulatorActual.openIosSimulatorApp);
  mockWithNormalizedStatusBar.mockImplementation(async (_device, capture) => await capture());
});

async function waitForFileText(filePath: string, attempts = 20): Promise<string> {
  let lastError: unknown;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      return await fs.readFile(filePath, 'utf8');
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }
  throw lastError;
}

test('shouldRetryIosSimulatorScreenshot detects simulator screen-surface timeout', () => {
  const error = new AppError('COMMAND_FAILED', 'Detected file type from extension: PNG', {
    stderr: 'Timeout waiting for screen surfaces',
    exitCode: 60,
  });
  assert.equal(shouldRetryIosSimulatorScreenshot(error), true);
});

test('shouldRetryIosSimulatorScreenshot detects timed out simctl screenshot command', () => {
  const error = new AppError('COMMAND_FAILED', 'xcrun timed out after 20000ms', {
    args: ['simctl', 'io', 'sim-1', 'screenshot', '/tmp/out.png'],
    timeoutMs: 20_000,
  });
  assert.equal(shouldRetryIosSimulatorScreenshot(error), true);
});

test('shouldRetryIosSimulatorScreenshot ignores unrelated screenshot failures', () => {
  const error = new AppError('COMMAND_FAILED', 'Failed to capture iOS screenshot', {
    stderr: 'No such file or directory',
    exitCode: 2,
  });
  assert.equal(shouldRetryIosSimulatorScreenshot(error), false);
});

test('captureSimulatorScreenshotWithFallback falls back to runner after retry exhaustion', async () => {
  const tmpDir = await mkdtempForTest('agent-device-ios-runner-fallback-');
  let ensureBootedCalls = 0;
  const containerPath = path.join(tmpDir, 'container');
  const runnerImage = path.join(containerPath, 'tmp', 'fallback.png');
  await fs.mkdir(path.dirname(runnerImage), { recursive: true });
  await fs.writeFile(runnerImage, 'runner-image', 'utf8');
  mockEnsureBootedSimulator.mockImplementation(async () => {
    ensureBootedCalls += 1;
  });
  mockOpenIosSimulatorApp.mockResolvedValue(undefined);
  mockRetryWithPolicy.mockRejectedValue(
    new AppError('COMMAND_FAILED', 'Detected file type from extension: PNG', {
      stderr: 'Timeout waiting for screen surfaces',
      exitCode: 60,
    }),
  );
  mockRunAppleRunnerCommand.mockResolvedValue({ message: 'tmp/fallback.png' });
  mockRunCmd.mockImplementation(async (_cmd, args) => {
    if (args.includes('get_app_container')) {
      return { exitCode: 0, stdout: `${containerPath}\n`, stderr: '' };
    }
    throw new Error(`Unexpected xcrun args: ${args.join(' ')}`);
  });

  try {
    const outPath = path.join(tmpDir, 'out.png');
    await captureSimulatorScreenshotWithFallback(IOS_TEST_SIMULATOR, outPath, {
      env: process.env,

      appBundleId: 'com.example.app',
      deps: {
        ensureBooted: ensureBootedSimulator,
        withNormalizedStatusBar: withNormalizedSimulatorStatusBar,
        captureWithRetry: captureSimulatorScreenshotWithRetry,
        normalizeDensity: async () => {},
        captureWithRunner: captureScreenshotViaRunner,
        shouldFallbackToRunner: shouldRetryIosSimulatorScreenshot,
        resolveCaptureTarget: async () => ({}),
      },
    });
    assert.equal(ensureBootedCalls, 1);
    assert.equal(mockRetryWithPolicy.mock.calls.length, 1);
    assert.equal(mockRunAppleRunnerCommand.mock.calls.length, 1);
    assert.equal(await fs.readFile(outPath, 'utf8'), 'runner-image');
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});

test('captureSimulatorScreenshotWithFallback falls back to runner after simctl screenshot timeout', async () => {
  const tmpDir = await mkdtempForTest('agent-device-ios-runner-timeout-');
  const containerPath = path.join(tmpDir, 'container');
  const runnerImage = path.join(containerPath, 'tmp', 'fallback-timeout.png');
  await fs.mkdir(path.dirname(runnerImage), { recursive: true });
  await fs.writeFile(runnerImage, 'runner-timeout', 'utf8');
  mockEnsureBootedSimulator.mockResolvedValue(undefined);
  mockOpenIosSimulatorApp.mockResolvedValue(undefined);
  mockRetryWithPolicy.mockRejectedValue(
    new AppError('COMMAND_FAILED', 'xcrun timed out after 20000ms', {
      args: ['simctl', 'io', 'sim-1', 'screenshot', '/tmp/out.png'],
      timeoutMs: 20_000,
    }),
  );
  mockRunAppleRunnerCommand.mockResolvedValue({ message: 'tmp/fallback-timeout.png' });
  mockRunCmd.mockImplementation(async (_cmd, args) => {
    if (args.includes('get_app_container')) {
      return { exitCode: 0, stdout: `${containerPath}\n`, stderr: '' };
    }
    throw new Error(`Unexpected xcrun args: ${args.join(' ')}`);
  });

  try {
    const outPath = path.join(tmpDir, 'out.png');
    await captureSimulatorScreenshotWithFallback(IOS_TEST_SIMULATOR, outPath, {
      env: process.env,

      appBundleId: 'com.example.app',
      deps: {
        ensureBooted: ensureBootedSimulator,
        withNormalizedStatusBar: withNormalizedSimulatorStatusBar,
        captureWithRetry: captureSimulatorScreenshotWithRetry,
        normalizeDensity: async () => {},
        captureWithRunner: captureScreenshotViaRunner,
        shouldFallbackToRunner: shouldRetryIosSimulatorScreenshot,
        resolveCaptureTarget: async () => ({}),
      },
    });
    assert.equal(mockRunAppleRunnerCommand.mock.calls.length, 1);
    assert.equal(await fs.readFile(outPath, 'utf8'), 'runner-timeout');
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});

test('captureSimulatorScreenshotWithFallback runs the capture inside status bar normalization', async () => {
  const steps: string[] = [];
  mockWithNormalizedStatusBar.mockImplementation(async (_device, capture) => {
    steps.push('normalize');
    const captured = await capture();
    steps.push('restore');
    return captured;
  });
  mockEnsureBootedSimulator.mockResolvedValue(undefined);
  mockOpenIosSimulatorApp.mockResolvedValue(undefined);
  mockRetryWithPolicy.mockImplementation(async () => {
    steps.push('capture');
  });
  await captureSimulatorScreenshotWithFallback(IOS_TEST_SIMULATOR, '/tmp/out.png', {
    env: process.env,

    appBundleId: 'com.example.app',
    normalizeStatusBar: true,
    deps: { normalizeDensity: async () => {} },
  });
  assert.deepEqual(steps, ['normalize', 'capture', 'restore']);
  assert.equal(mockRunAppleRunnerCommand.mock.calls.length, 0);
});

test('captureSimulatorScreenshotWithFallback can skip session-backed simulator boot probe', async () => {
  mockEnsureBootedSimulator.mockRejectedValue(new Error('should not probe boot state'));
  mockRetryWithPolicy.mockResolvedValue(undefined);

  await captureSimulatorScreenshotWithFallback(IOS_TEST_SIMULATOR, '/tmp/out.png', {
    env: process.env,

    appBundleId: 'com.example.app',
    skipIosSimulatorBootCheck: true,
    deps: { normalizeDensity: async () => {} },
  });

  assert.equal(mockEnsureBootedSimulator.mock.calls.length, 0);
  assert.equal(mockRetryWithPolicy.mock.calls.length, 1);
  assert.equal(mockRunAppleRunnerCommand.mock.calls.length, 0);
});

test('captureSimulatorScreenshotWithFallback boots skipped-check simulator after shutdown screenshot failure', async () => {
  const ensureBooted = vi.fn(async () => {});
  let captureAttempts = 0;
  const captureWithRetry = vi.fn(async () => {
    captureAttempts += 1;
    if (captureAttempts === 1) {
      throw new AppError('COMMAND_FAILED', 'simctl screenshot failed', {
        stderr: 'Unable to boot device in current state: Shutdown',
        args: ['simctl', 'io', 'sim-1', 'screenshot', '/tmp/out.png'],
      });
    }
  });
  const captureWithRunner = vi.fn(async () => undefined);

  await captureSimulatorScreenshotWithFallback(IOS_TEST_SIMULATOR, '/tmp/out.png', {
    env: process.env,

    appBundleId: 'com.example.app',
    skipIosSimulatorBootCheck: true,
    deps: {
      ensureBooted,
      captureWithRetry,
      normalizeDensity: async () => {},
      captureWithRunner,
      shouldFallbackToRunner: shouldRetryIosSimulatorScreenshot,
      resolveCaptureTarget: async () => ({}),
    },
  });

  assert.equal(ensureBooted.mock.calls.length, 1);
  assert.equal(captureWithRetry.mock.calls.length, 2);
  assert.equal(captureWithRunner.mock.calls.length, 0);
});

test('captureSimulatorScreenshotWithFallback keeps runner fallback after skipped-check boot recovery', async () => {
  const ensureBooted = vi.fn(async () => {});
  let captureAttempts = 0;
  const captureWithRetry = vi.fn(async () => {
    captureAttempts += 1;
    if (captureAttempts === 1) {
      throw new AppError('COMMAND_FAILED', 'simctl screenshot failed', {
        stderr: 'Unable to boot device in current state: Shutdown',
        args: ['simctl', 'io', 'sim-1', 'screenshot', '/tmp/out.png'],
      });
    }
    throw new AppError('COMMAND_FAILED', 'xcrun timed out after 20000ms', {
      args: ['simctl', 'io', 'sim-1', 'screenshot', '/tmp/out.png'],
      timeoutMs: 20_000,
    });
  });
  const captureWithRunner = vi.fn(async () => undefined);

  await captureSimulatorScreenshotWithFallback(IOS_TEST_SIMULATOR, '/tmp/out.png', {
    env: process.env,

    appBundleId: 'com.example.app',
    skipIosSimulatorBootCheck: true,
    deps: {
      ensureBooted,
      captureWithRetry,
      normalizeDensity: async () => {},
      captureWithRunner,
      shouldFallbackToRunner: shouldRetryIosSimulatorScreenshot,
      resolveCaptureTarget: async () => ({}),
    },
  });

  assert.equal(ensureBooted.mock.calls.length, 1);
  assert.equal(captureWithRetry.mock.calls.length, 2);
  assert.equal(captureWithRunner.mock.calls.length, 1);
});

test('captureSimulatorScreenshotWithFallback skips status bar normalization by default', async () => {
  mockEnsureBootedSimulator.mockResolvedValue(undefined);
  mockOpenIosSimulatorApp.mockResolvedValue(undefined);
  mockRetryWithPolicy.mockResolvedValue(undefined);

  await captureSimulatorScreenshotWithFallback(IOS_TEST_SIMULATOR, '/tmp/out.png', {
    env: process.env,

    appBundleId: 'com.example.app',
    deps: { normalizeDensity: async () => {} },
  });

  assert.equal(mockWithNormalizedStatusBar.mock.calls.length, 0);
  assert.equal(mockRetryWithPolicy.mock.calls.length > 0, true);
  assert.equal(mockRunAppleRunnerCommand.mock.calls.length, 0);
});

test('captureSimulatorScreenshotWithFallback keeps the runner fallback inside the normalization window', async () => {
  const steps: string[] = [];
  mockWithNormalizedStatusBar.mockImplementation(async (_device, capture) => {
    steps.push('normalize');
    const captured = await capture();
    steps.push('restore');
    return captured;
  });
  mockEnsureBootedSimulator.mockResolvedValue(undefined);
  mockOpenIosSimulatorApp.mockResolvedValue(undefined);
  mockRetryWithPolicy.mockRejectedValue(
    new AppError('COMMAND_FAILED', 'xcrun timed out after 20000ms', {
      args: ['simctl', 'io', 'sim-1', 'screenshot', '/tmp/out.png'],
      timeoutMs: 20_000,
    }),
  );

  await captureSimulatorScreenshotWithFallback(IOS_TEST_SIMULATOR, '/tmp/out.png', {
    env: process.env,
    appBundleId: 'com.example.app',
    normalizeStatusBar: true,
    deps: {
      normalizeDensity: async () => {},
      resolveCaptureTarget: async () => ({}),
      shouldFallbackToRunner: shouldRetryIosSimulatorScreenshot,
      captureWithRunner: async () => {
        steps.push('runner fallback capture');
        return undefined;
      },
    },
  });

  assert.deepEqual(steps, ['normalize', 'runner fallback capture', 'restore']);
});

test('captureSimulatorScreenshotWithFallback emits fallback diagnostic before using runner', async () => {
  const tmpDir = await mkdtempForTest('agent-device-ios-screenshot-diag-test-');
  const logPath = path.join(tmpDir, 'diag.ndjson');
  try {
    await withDiagnosticsScope(
      {
        debug: true,
        logPath,
        session: 'ios-test',
        requestId: 'req-1',
        command: 'screenshot',
      },
      async () => {
        const containerPath = path.join(tmpDir, 'container');
        const runnerImage = path.join(containerPath, 'tmp', 'diag-fallback.png');
        await fs.mkdir(path.dirname(runnerImage), { recursive: true });
        await fs.writeFile(runnerImage, 'diag-fallback', 'utf8');
        mockEnsureBootedSimulator.mockResolvedValue(undefined);
        mockOpenIosSimulatorApp.mockResolvedValue(undefined);
        mockWithNormalizedStatusBar.mockImplementation(async (_device, capture) => await capture());
        mockRetryWithPolicy.mockRejectedValue(
          new AppError('COMMAND_FAILED', 'xcrun timed out after 20000ms', {
            args: ['simctl', 'io', 'sim-1', 'screenshot', '/tmp/out.png'],
            timeoutMs: 20_000,
          }),
        );
        mockRunAppleRunnerCommand.mockResolvedValue({ message: 'tmp/diag-fallback.png' });
        mockRunCmd.mockImplementation(async (_cmd, args) => {
          if (args.includes('get_app_container')) {
            return { exitCode: 0, stdout: `${containerPath}\n`, stderr: '' };
          }
          throw new Error(`Unexpected xcrun args: ${args.join(' ')}`);
        });
        await captureSimulatorScreenshotWithFallback(IOS_TEST_SIMULATOR, '/tmp/out.png', {
          env: process.env,

          appBundleId: 'com.example.app',
          deps: {
            ensureBooted: ensureBootedSimulator,
            withNormalizedStatusBar: withNormalizedSimulatorStatusBar,
            captureWithRetry: captureSimulatorScreenshotWithRetry,
            normalizeDensity: async () => {},
            captureWithRunner: captureScreenshotViaRunner,
            shouldFallbackToRunner: shouldRetryIosSimulatorScreenshot,
            resolveCaptureTarget: async () => ({}),
          },
        });
      },
    );

    const log = await waitForFileText(logPath);
    assert.match(log, /"phase":"ios_screenshot_fallback"/);
    assert.match(log, /"deviceId":"sim-1"/);
    assert.match(log, /"errorCode":"COMMAND_FAILED"/);
    assert.match(log, /"from":"simctl_screenshot"/);
    assert.match(log, /"to":"runner"/);
    assert.match(log, /"commandArgs":"simctl io sim-1 screenshot \/tmp\/out\.png"/);
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});

test('captureSimulatorScreenshotWithFallback uses simulator runner fallback by default', async () => {
  const tmpDir = await mkdtempForTest('agent-device-ios-default-fallback-');
  const containerPath = path.join(tmpDir, 'container');
  const runnerImage = path.join(containerPath, 'tmp', 'default-fallback.png');
  await fs.mkdir(path.dirname(runnerImage), { recursive: true });
  await fs.writeFile(runnerImage, 'default-fallback', 'utf8');
  mockEnsureBootedSimulator.mockResolvedValue(undefined);
  mockOpenIosSimulatorApp.mockResolvedValue(undefined);
  mockRetryWithPolicy.mockRejectedValue(
    new AppError('COMMAND_FAILED', 'xcrun timed out after 20000ms', {
      args: ['simctl', 'io', 'sim-1', 'screenshot', '/tmp/out.png'],
      timeoutMs: 20_000,
    }),
  );
  mockRunAppleRunnerCommand.mockResolvedValue({ message: 'tmp/default-fallback.png' });
  mockRunCmd.mockImplementation(async (_cmd, args) => {
    if (args.includes('get_app_container')) {
      return { exitCode: 0, stdout: `${containerPath}\n`, stderr: '' };
    }
    throw new Error(`Unexpected xcrun args: ${args.join(' ')}`);
  });

  try {
    const outPath = path.join(tmpDir, 'out.png');
    await captureSimulatorScreenshotWithFallback(IOS_TEST_SIMULATOR, outPath, {
      env: process.env,

      appBundleId: 'com.example.app',
      deps: { normalizeDensity: async () => {} },
    });
    assert.equal(mockRunAppleRunnerCommand.mock.calls.length, 1);
    assert.equal(await fs.readFile(outPath, 'utf8'), 'default-fallback');
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});

test('resolveRunnerScreenshotFilePaths preserves the runner path and handles legacy absolute paths', () => {
  assert.deepEqual(resolveRunnerScreenshotFilePaths('/private/var/mobile/tmp/fallback.png'), [
    '/private/var/mobile/tmp/fallback.png',
    'tmp/fallback.png',
  ]);
  assert.deepEqual(resolveRunnerScreenshotFilePaths('tmp/current.png'), ['tmp/current.png']);
});

test('resolveRunnerScreenshotFilePaths handles an empty runner path', () => {
  assert.deepEqual(resolveRunnerScreenshotFilePaths('   '), []);
});

test('captureScreenshotViaRunner treats a (null) data-container answer as no container', async () => {
  const tmpDir = await mkdtempForTest('agent-device-runner-null-container-');
  const device = { ...IOS_TEST_SIMULATOR, id: 'sim-runner-null-container' };
  mockRunAppleRunnerCommand.mockResolvedValue({ message: 'tmp/null.png' });
  mockRunCmd.mockImplementation(async (_cmd, args) => {
    if (args.includes('get_app_container')) {
      return { exitCode: 0, stdout: '(null)\n', stderr: '' };
    }
    throw new Error(`Unexpected xcrun args: ${args.join(' ')}`);
  });

  try {
    const outPath = path.join(tmpDir, 'out.png');
    await assert.rejects(
      () =>
        captureScreenshotViaRunner(device, outPath, undefined, undefined, undefined, process.env),
      (error: unknown) => {
        assert.ok(error instanceof AppError);
        assert.equal(error.code, 'COMMAND_FAILED');
        assert.match(error.message, /returned no data container path/);
        return true;
      },
    );
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});

test('captureScreenshotViaRunner reuses a verified simulator container path', async () => {
  const tmpDir = await mkdtempForTest('agent-device-runner-cache-');
  const containerPath = path.join(tmpDir, 'container');
  const runnerImage = path.join(containerPath, 'tmp', 'capture.png');
  const device = { ...IOS_TEST_SIMULATOR, id: 'sim-runner-container-cache' };
  await fs.mkdir(path.dirname(runnerImage), { recursive: true });
  await fs.writeFile(runnerImage, 'runner-image', 'utf8');
  mockRunAppleRunnerCommand.mockResolvedValue({ message: 'tmp/capture.png' });
  mockRunCmd.mockImplementation(async (_cmd, args) => {
    if (args.includes('get_app_container')) {
      return { exitCode: 0, stdout: `${containerPath}\n`, stderr: '' };
    }
    throw new Error(`Unexpected xcrun args: ${args.join(' ')}`);
  });

  try {
    const firstPath = path.join(tmpDir, 'first.png');
    const secondPath = path.join(tmpDir, 'second.png');
    await captureScreenshotViaRunner(
      device,
      firstPath,
      undefined,
      undefined,
      undefined,
      process.env,
    );
    await captureScreenshotViaRunner(
      device,
      secondPath,
      undefined,
      undefined,
      undefined,
      process.env,
    );

    assert.equal(await fs.readFile(firstPath, 'utf8'), 'runner-image');
    assert.equal(await fs.readFile(secondPath, 'utf8'), 'runner-image');
    assert.equal(mockRunAppleRunnerCommand.mock.calls.length, 2);
    assert.equal(
      mockRunCmd.mock.calls.filter(([, args]) => args.includes('get_app_container')).length,
      1,
    );
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});

test('captureScreenshotViaRunner reports the display facts a runner capture measured', async () => {
  const tmpDir = await mkdtempForTest('agent-device-runner-metadata-');
  const containerPath = path.join(tmpDir, 'container');
  const runnerImage = path.join(containerPath, 'tmp', 'duo.png');
  const device = { ...IOS_TEST_SIMULATOR, id: 'sim-runner-metadata' };
  await fs.mkdir(path.dirname(runnerImage), { recursive: true });
  await fs.writeFile(runnerImage, 'runner-image', 'utf8');
  mockRunAppleRunnerCommand.mockResolvedValue({
    message: 'tmp/duo.png',
    [SCREEN_CAPTURE_TABLE.key]: MEASURED_CAPTURE.metadata,
  });
  mockRunCmd.mockImplementation(async (_cmd, args) => {
    if (args.includes('get_app_container')) {
      return { exitCode: 0, stdout: `${containerPath}\n`, stderr: '' };
    }
    throw new Error(`Unexpected xcrun args: ${args.join(' ')}`);
  });

  try {
    const outPath = path.join(tmpDir, 'out.png');
    const metadata = await captureScreenshotViaRunner(
      device,
      outPath,
      undefined,
      undefined,
      undefined,
      process.env,
    );
    assert.deepEqual(metadata, MEASURED_CAPTURE.metadata);
    assert.equal(await fs.readFile(outPath, 'utf8'), 'runner-image');
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});

// Both capture legs of one request run inside the status bar window, and the runner leg takes that
// same window for itself. This drives the real normalization around the real runner fallback, with
// only the tools faked, so the nesting is exercised rather than assumed.
test('captureSimulatorScreenshotWithFallback keeps the real runner fallback inside its own status bar window', async () => {
  const tmpDir = await mkdtempForTest('agent-device-normalized-runner-fallback-');
  const device = { ...IOS_TEST_SIMULATOR, id: 'sim-1' };
  const containerPath = path.join(tmpDir, 'container');
  const runnerImage = path.join(containerPath, 'tmp', 'fallback-window.png');
  await fs.mkdir(path.dirname(runnerImage), { recursive: true });
  await fs.writeFile(runnerImage, 'runner-window-image', 'utf8');
  const timeline: string[] = [];
  const steps: string[] = [];

  // The file's mock of the status bar owner stands in for the plain pass-through by default; this
  // case needs the real transaction, so it restores the implementation `vi.fn` was created with.
  mockWithNormalizedStatusBar.mockReset();
  invalidateSimulatorStatusBarOverrideCache(device);
  mockRetryWithPolicy.mockRejectedValue(
    new AppError('COMMAND_FAILED', 'Detected file type from extension: PNG', {
      stderr: 'Timeout waiting for screen surfaces',
      exitCode: 60,
    }),
  );
  mockRunAppleRunnerCommand.mockImplementation(async () => {
    steps.push('runner');
    timeline.push('runner');
    return { message: 'tmp/fallback-window.png' };
  });
  mockRunCmd.mockImplementation(async (cmd, args) => {
    const argv = [cmd, ...(args ?? [])].join(' ');
    if (argv.includes('status_bar')) {
      timeline.push(`status_bar:${/status_bar\s+\S+\s+(\S+)/.exec(argv)?.[1]}`);
      return {
        exitCode: 0,
        stdout: 'Current Status Bar Overrides:\n=============================\n',
        stderr: '',
      };
    }
    if (argv.includes('get_app_container')) {
      return { exitCode: 0, stdout: `${containerPath}\n`, stderr: '' };
    }
    throw new Error(`Unexpected command: ${argv}`);
  });

  try {
    const outPath = path.join(tmpDir, 'out.png');
    await captureSimulatorScreenshotWithFallback(device, outPath, {
      env: process.env,
      normalizeStatusBar: true,
      skipIosSimulatorBootCheck: true,
      deps: {
        captureWithRetry: captureSimulatorScreenshotWithRetry,
        normalizeDensity: async () => {},
        captureWithRunner: captureScreenshotViaRunner,
        shouldFallbackToRunner: shouldRetryIosSimulatorScreenshot,
        resolveCaptureTarget: async () => ({}),
      },
    });

    assert.deepEqual(steps, ['runner']);
    assert.equal(await fs.readFile(outPath, 'utf8'), 'runner-window-image');
    // The window belongs to the request: it opens before either capture and closes after the
    // runner capture, and the runner leg re-enters that window instead of opening its own.
    assert.deepEqual(timeline, [
      'status_bar:list',
      'status_bar:override',
      'runner',
      'status_bar:clear',
    ]);
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});

test('captureScreenshotViaRunner waits for a held simulator status bar', async () => {
  const tmpDir = await mkdtempForTest('agent-device-runner-bar-window-');
  const containerPath = path.join(tmpDir, 'container');
  const runnerImage = path.join(containerPath, 'tmp', 'held.png');
  const device = { ...IOS_TEST_SIMULATOR, id: 'sim-runner-held' };
  await fs.mkdir(path.dirname(runnerImage), { recursive: true });
  await fs.writeFile(runnerImage, 'runner-image', 'utf8');

  let releaseHolder!: () => void;
  const held = new Promise<void>((resolve) => {
    releaseHolder = resolve;
  });
  let releaseRunnerCommand!: () => void;
  const runnerCommandReleased = new Promise<void>((resolve) => {
    releaseRunnerCommand = resolve;
  });
  let releaseHolderGate!: () => void;
  const holderEntered = new Promise<void>((resolve) => {
    releaseHolderGate = resolve;
  });

  mockRunAppleRunnerCommand.mockImplementation(async () => {
    await runnerCommandReleased;
    return { message: 'tmp/held.png' };
  });
  mockRunCmd.mockImplementation(async (_cmd, args) => {
    if (args.includes('get_app_container')) {
      return { exitCode: 0, stdout: `${containerPath}\n`, stderr: '' };
    }
    throw new Error(`Unexpected xcrun args: ${args.join(' ')}`);
  });

  const holder = withSimulatorStatusBarHeld(device, async () => {
    releaseHolderGate();
    await held;
  });

  try {
    await holderEntered;
    const outPath = path.join(tmpDir, 'out.png');
    const runnerCapture = captureScreenshotViaRunner(
      device,
      outPath,
      undefined,
      undefined,
      undefined,
      process.env,
    );
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(
      mockRunAppleRunnerCommand.mock.calls.length,
      0,
      'a runner capture must wait while another capture holds the status bar',
    );

    releaseHolder();
    await holder;
    await new Promise((resolve) => setImmediate(resolve));
    releaseRunnerCommand();
    await runnerCapture;
    assert.equal(mockRunAppleRunnerCommand.mock.calls.length, 1);
    assert.equal(await fs.readFile(outPath, 'utf8'), 'runner-image');
  } finally {
    releaseHolder();
    releaseRunnerCommand();
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});

test('captureScreenshotViaRunner reports no display facts for a pre-panel runner', async () => {
  const tmpDir = await mkdtempForTest('agent-device-runner-no-metadata-');
  const containerPath = path.join(tmpDir, 'container');
  const runnerImage = path.join(containerPath, 'tmp', 'legacy.png');
  const device = { ...IOS_TEST_SIMULATOR, id: 'sim-runner-no-metadata' };
  await fs.mkdir(path.dirname(runnerImage), { recursive: true });
  await fs.writeFile(runnerImage, 'runner-image', 'utf8');
  mockRunAppleRunnerCommand.mockResolvedValue({ message: 'tmp/legacy.png' });
  mockRunCmd.mockImplementation(async (_cmd, args) => {
    if (args.includes('get_app_container')) {
      return { exitCode: 0, stdout: `${containerPath}\n`, stderr: '' };
    }
    throw new Error(`Unexpected xcrun args: ${args.join(' ')}`);
  });

  try {
    const outPath = path.join(tmpDir, 'out.png');
    assert.equal(
      await captureScreenshotViaRunner(
        device,
        outPath,
        undefined,
        undefined,
        undefined,
        process.env,
      ),
      undefined,
    );
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});

test('captureScreenshotViaRunner copies macOS runner screenshots from the host', async () => {
  const tmpDir = await mkdtempForTest('agent-device-macos-screenshot-');
  const sourcePath = path.join(tmpDir, 'runner.png');
  const outPath = path.join(tmpDir, 'screen.png');
  await fs.writeFile(sourcePath, 'runner-image', 'utf8');
  mockRunAppleRunnerCommand.mockResolvedValue({ message: sourcePath });
  mockRunCmd.mockRejectedValue(new Error('macOS screenshot must not invoke xcrun devicectl'));

  try {
    await captureScreenshotViaRunner(
      MACOS_TEST_DEVICE,
      outPath,
      undefined,
      undefined,
      undefined,
      process.env,
    );
    assert.equal(await fs.readFile(outPath, 'utf8'), 'runner-image');
    assert.equal(mockRunCmd.mock.calls.length, 0);
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});

test('captureSimulatorScreenshotWithFallback reports the panel rotation for a simctl capture', async () => {
  const facts = await captureSimulatorScreenshotWithFallback(IOS_TEST_SIMULATOR, '/tmp/s.png', {
    env: process.env,

    skipIosSimulatorBootCheck: true,
    deps: {
      ensureBooted: async () => {},
      normalizeDensity: async () => {},
      captureWithRunner: async () => undefined,
      shouldFallbackToRunner: () => true,
      resolveCaptureTarget: async () => ({ displayRotation: 'landscape-left' }),
      captureWithRetry: async () => {},
    },
  });
  assert.deepEqual(facts, { displayRotation: 'landscape-left' });
});

test('captureSimulatorScreenshotWithFallback keeps the panel rotation for a runner fallback capture', async () => {
  const facts = await captureSimulatorScreenshotWithFallback(IOS_TEST_SIMULATOR, '/tmp/s.png', {
    env: process.env,

    skipIosSimulatorBootCheck: true,
    deps: {
      ensureBooted: async () => {},
      normalizeDensity: async () => {},
      captureWithRunner: async () => undefined,
      shouldFallbackToRunner: () => true,
      resolveCaptureTarget: async () => ({ displayRotation: 'landscape-right' }),
      captureWithRetry: async () => {
        throw new Error('simctl screenshot failed');
      },
    },
  });
  assert.deepEqual(facts, { displayRotation: 'landscape-right' });
});

test('an explicit screen mask refuses an unmasked runner fallback after simctl exhaustion', async () => {
  const failure = new AppError('COMMAND_FAILED', 'capture failed', {
    stderr: 'Timeout waiting for screen surfaces',
  });
  mockRetryWithPolicy.mockRejectedValue(failure);
  await assert.rejects(
    captureSimulatorScreenshotWithFallback(IOS_TEST_SIMULATOR, '/tmp/masked.png', {
      env: {},
      screenMask: 'black',
      skipIosSimulatorBootCheck: true,
      deps: {
        resolveCaptureTarget: async () => ({}),
        captureWithRetry: captureSimulatorScreenshotWithRetry,
        captureWithRunner: captureScreenshotViaRunner,
        normalizeDensity: async () => {},
      },
    }),
    (error) => error === failure,
  );
  assert.equal(mockRunAppleRunnerCommand.mock.calls.length, 0);
});

test.each([MACOS_TEST_DEVICE, { ...IOS_TEST_SIMULATOR, kind: 'device' as const }])(
  'screenshotIos refuses a masked $kind capture outside simctl before native execution',
  async (device) => {
    mockRunCmd.mockRejectedValue(new Error('unexpected native capture'));
    mockRunAppleRunnerCommand.mockRejectedValue(new Error('unexpected runner capture'));
    await assert.rejects(
      screenshotIos(device, '/tmp/masked.png', { env: {}, screenMask: 'black' }),
      {
        code: 'UNSUPPORTED_OPERATION',
        details: { reason: 'screenshot-screen-mask-unsupported' },
      },
    );
    assert.equal(mockRunCmd.mock.calls.length, 0);
    assert.equal(mockRunAppleRunnerCommand.mock.calls.length, 0);
  },
);

test.each([
  ['the default capture', undefined, true],
  ['an explicit runner capture', undefined, true],
  ['an explicit runner capture', false, false],
] as const)(
  '%s under a runner-backed tool provider asks the runner with fullscreen %s: %s',
  async (route, fullscreen, expected) => {
    mockRunAppleRunnerCommand.mockRejectedValue(new Error('stop after the runner request'));
    const capture = async () =>
      route === 'the default capture'
        ? await captureSimulatorScreenshotWithFallback(IOS_TEST_SIMULATOR, '/tmp/runner.png', {
            env: {},
            fullscreen,
            skipIosSimulatorBootCheck: true,
            deps: { resolveCaptureTarget: async () => ({}) },
          })
        : await captureScreenshotViaRunner(
            IOS_TEST_SIMULATOR,
            '/tmp/runner.png',
            undefined,
            fullscreen,
            undefined,
            {},
          );
    await withAppleToolProvider(
      { ...resolveAppleToolProvider(), simulatorScreenshotBackend: 'runner' },
      async () => {
        await assert.rejects(capture(), /stop after the runner request/);
      },
    );
    assert.equal(mockRunAppleRunnerCommand.mock.calls[0]?.[1]?.fullscreen, expected);
  },
);

test('a macOS runner capture under a runner-backed tool provider skips the fullscreen default', async () => {
  mockRunAppleRunnerCommand.mockRejectedValue(new Error('stop after the runner request'));
  await withAppleToolProvider(
    { ...resolveAppleToolProvider(), simulatorScreenshotBackend: 'runner' },
    async () => {
      await assert.rejects(
        captureScreenshotViaRunner(
          { ...MACOS_TEST_DEVICE, kind: 'simulator' },
          '/tmp/runner.png',
          undefined,
          undefined,
          undefined,
          {},
        ),
        /stop after the runner request/,
      );
    },
  );
  assert.equal(mockRunAppleRunnerCommand.mock.calls[0]?.[1]?.fullscreen, undefined);
});

test('an explicit runner capture outside a runner-backed tool provider leaves fullscreen unset', async () => {
  mockRunAppleRunnerCommand.mockRejectedValue(new Error('stop after the runner request'));
  await assert.rejects(
    captureScreenshotViaRunner(
      IOS_TEST_SIMULATOR,
      '/tmp/runner.png',
      undefined,
      undefined,
      undefined,
      {},
    ),
    /stop after the runner request/,
  );
  assert.equal(mockRunAppleRunnerCommand.mock.calls[0]?.[1]?.fullscreen, undefined);
});

test('screenshotIos rejects a screen mask before a provider-owned runner capture', async () => {
  mockRunCmd.mockRejectedValue(new Error('unexpected native capture'));
  mockRunAppleRunnerCommand.mockRejectedValue(new Error('unexpected runner capture'));
  await withAppleToolProvider(
    { ...resolveAppleToolProvider(), simulatorScreenshotBackend: 'runner' },
    async () => {
      await assert.rejects(
        screenshotIos(IOS_TEST_SIMULATOR, '/tmp/masked.png', { env: {}, screenMask: 'black' }),
        {
          code: 'UNSUPPORTED_OPERATION',
          details: { reason: 'screenshot-screen-mask-unsupported' },
        },
      );
    },
  );
  assert.equal(mockRunCmd.mock.calls.length, 0);
  assert.equal(mockRunAppleRunnerCommand.mock.calls.length, 0);
});
