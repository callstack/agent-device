import { beforeEach, test, vi } from 'vitest';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { mkdtempForTest } from '../../../../__tests__/test-utils/tmp-dir.ts';

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
    prepareSimulatorStatusBarForScreenshot: vi.fn(actual.prepareSimulatorStatusBarForScreenshot),
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
const screenshotStatusBarActual = await vi.importActual<
  typeof import('../screenshot-status-bar.ts')
>('../screenshot-status-bar.ts');

import {
  captureSimulatorScreenshotWithFallback,
  captureSimulatorScreenshotWithRetry,
  captureScreenshotViaRunner,
  resolveSimulatorRunnerScreenshotCandidatePaths,
  shouldRetryIosSimulatorScreenshot,
} from '../screenshot.ts';
import { ensureBootedSimulator, openIosSimulatorApp } from '../simulator.ts';
import { prepareSimulatorStatusBarForScreenshot } from '../screenshot-status-bar.ts';
import { runAppleRunnerCommand } from '../runner-client.ts';
import { runCmd } from '@agent-device/host-kit/command';
import { withDiagnosticsScope } from '@agent-device/host-kit/diagnostics';
import { retryWithPolicy } from '@agent-device/host-kit/retry';
import { AppError } from '@agent-device/kernel/errors';

import { IOS_TEST_SIMULATOR, MACOS_TEST_DEVICE } from './apple-core-stub-helpers.ts';

const mockRunCmd = vi.mocked(runCmd);
const mockRetryWithPolicy = vi.mocked(retryWithPolicy);
const mockRunAppleRunnerCommand = vi.mocked(runAppleRunnerCommand);
const mockEnsureBootedSimulator = vi.mocked(ensureBootedSimulator);
const mockOpenIosSimulatorApp = vi.mocked(openIosSimulatorApp);
const mockPrepareStatusBarForScreenshot = vi.mocked(prepareSimulatorStatusBarForScreenshot);

beforeEach(() => {
  vi.resetAllMocks();
  mockRunCmd.mockImplementation(execActual.runCmd);
  mockRetryWithPolicy.mockImplementation(retryActual.retryWithPolicy);
  mockRunAppleRunnerCommand.mockImplementation(runnerActual.runAppleRunnerCommand);
  mockEnsureBootedSimulator.mockImplementation(simulatorActual.ensureBootedSimulator);
  mockOpenIosSimulatorApp.mockImplementation(simulatorActual.openIosSimulatorApp);
  mockPrepareStatusBarForScreenshot.mockImplementation(
    screenshotStatusBarActual.prepareSimulatorStatusBarForScreenshot,
  );
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
  mockPrepareStatusBarForScreenshot.mockResolvedValue(async () => {});
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
      appBundleId: 'com.example.app',
      deps: {
        ensureBooted: ensureBootedSimulator,
        prepareStatusBarForScreenshot: prepareSimulatorStatusBarForScreenshot,
        captureWithRetry: captureSimulatorScreenshotWithRetry,
        normalizeDensity: async () => {},
        captureWithRunner: captureScreenshotViaRunner,
        shouldFallbackToRunner: shouldRetryIosSimulatorScreenshot,
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
  mockPrepareStatusBarForScreenshot.mockResolvedValue(async () => {});
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
      appBundleId: 'com.example.app',
      deps: {
        ensureBooted: ensureBootedSimulator,
        prepareStatusBarForScreenshot: prepareSimulatorStatusBarForScreenshot,
        captureWithRetry: captureSimulatorScreenshotWithRetry,
        normalizeDensity: async () => {},
        captureWithRunner: captureScreenshotViaRunner,
        shouldFallbackToRunner: shouldRetryIosSimulatorScreenshot,
      },
    });
    assert.equal(mockRunAppleRunnerCommand.mock.calls.length, 1);
    assert.equal(await fs.readFile(outPath, 'utf8'), 'runner-timeout');
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});

test('captureSimulatorScreenshotWithFallback continues when status bar preparation fails', async () => {
  mockPrepareStatusBarForScreenshot.mockRejectedValue(
    new AppError('COMMAND_FAILED', 'status_bar override failed'),
  );
  mockEnsureBootedSimulator.mockResolvedValue(undefined);
  mockOpenIosSimulatorApp.mockResolvedValue(undefined);
  mockRetryWithPolicy.mockResolvedValue(undefined);
  await captureSimulatorScreenshotWithFallback(IOS_TEST_SIMULATOR, '/tmp/out.png', {
    appBundleId: 'com.example.app',
    normalizeStatusBar: true,
    deps: { normalizeDensity: async () => {} },
  });
  assert.equal(mockPrepareStatusBarForScreenshot.mock.calls.length, 1);
  assert.equal(mockRetryWithPolicy.mock.calls.length > 0, true);
  assert.equal(mockRunAppleRunnerCommand.mock.calls.length, 0);
});

test('captureSimulatorScreenshotWithFallback can skip session-backed simulator boot probe', async () => {
  mockEnsureBootedSimulator.mockRejectedValue(new Error('should not probe boot state'));
  mockPrepareStatusBarForScreenshot.mockResolvedValue(async () => {});
  mockRetryWithPolicy.mockResolvedValue(undefined);

  await captureSimulatorScreenshotWithFallback(IOS_TEST_SIMULATOR, '/tmp/out.png', {
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
  const prepareStatusBarForScreenshot = vi.fn(async () => async () => {});
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
  const captureWithRunner = vi.fn(async () => {});

  await captureSimulatorScreenshotWithFallback(IOS_TEST_SIMULATOR, '/tmp/out.png', {
    appBundleId: 'com.example.app',
    skipIosSimulatorBootCheck: true,
    deps: {
      ensureBooted,
      prepareStatusBarForScreenshot,
      captureWithRetry,
      normalizeDensity: async () => {},
      captureWithRunner,
      shouldFallbackToRunner: shouldRetryIosSimulatorScreenshot,
    },
  });

  assert.equal(ensureBooted.mock.calls.length, 1);
  assert.equal(captureWithRetry.mock.calls.length, 2);
  assert.equal(captureWithRunner.mock.calls.length, 0);
});

test('captureSimulatorScreenshotWithFallback keeps runner fallback after skipped-check boot recovery', async () => {
  const ensureBooted = vi.fn(async () => {});
  const prepareStatusBarForScreenshot = vi.fn(async () => async () => {});
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
  const captureWithRunner = vi.fn(async () => {});

  await captureSimulatorScreenshotWithFallback(IOS_TEST_SIMULATOR, '/tmp/out.png', {
    appBundleId: 'com.example.app',
    skipIosSimulatorBootCheck: true,
    deps: {
      ensureBooted,
      prepareStatusBarForScreenshot,
      captureWithRetry,
      normalizeDensity: async () => {},
      captureWithRunner,
      shouldFallbackToRunner: shouldRetryIosSimulatorScreenshot,
    },
  });

  assert.equal(ensureBooted.mock.calls.length, 1);
  assert.equal(captureWithRetry.mock.calls.length, 2);
  assert.equal(captureWithRunner.mock.calls.length, 1);
});

test('captureSimulatorScreenshotWithFallback ignores status bar restore failures', async () => {
  mockPrepareStatusBarForScreenshot.mockResolvedValue(async () => {
    throw new AppError('COMMAND_FAILED', 'status_bar clear failed');
  });
  mockEnsureBootedSimulator.mockResolvedValue(undefined);
  mockOpenIosSimulatorApp.mockResolvedValue(undefined);
  mockRetryWithPolicy.mockResolvedValue(undefined);
  await captureSimulatorScreenshotWithFallback(IOS_TEST_SIMULATOR, '/tmp/out.png', {
    appBundleId: 'com.example.app',
    normalizeStatusBar: true,
    deps: { normalizeDensity: async () => {} },
  });
  assert.equal(mockPrepareStatusBarForScreenshot.mock.calls.length, 1);
  assert.equal(mockRetryWithPolicy.mock.calls.length > 0, true);
  assert.equal(mockRunAppleRunnerCommand.mock.calls.length, 0);
});

test('captureSimulatorScreenshotWithFallback skips status bar normalization by default', async () => {
  mockPrepareStatusBarForScreenshot.mockResolvedValue(async () => {});
  mockEnsureBootedSimulator.mockResolvedValue(undefined);
  mockOpenIosSimulatorApp.mockResolvedValue(undefined);
  mockRetryWithPolicy.mockResolvedValue(undefined);

  await captureSimulatorScreenshotWithFallback(IOS_TEST_SIMULATOR, '/tmp/out.png', {
    appBundleId: 'com.example.app',
    deps: { normalizeDensity: async () => {} },
  });

  assert.equal(mockPrepareStatusBarForScreenshot.mock.calls.length, 0);
  assert.equal(mockRetryWithPolicy.mock.calls.length > 0, true);
  assert.equal(mockRunAppleRunnerCommand.mock.calls.length, 0);
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
        mockPrepareStatusBarForScreenshot.mockResolvedValue(async () => {});
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
          appBundleId: 'com.example.app',
          deps: {
            ensureBooted: ensureBootedSimulator,
            prepareStatusBarForScreenshot: prepareSimulatorStatusBarForScreenshot,
            captureWithRetry: captureSimulatorScreenshotWithRetry,
            normalizeDensity: async () => {},
            captureWithRunner: captureScreenshotViaRunner,
            shouldFallbackToRunner: shouldRetryIosSimulatorScreenshot,
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
  mockPrepareStatusBarForScreenshot.mockResolvedValue(async () => {});
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
      appBundleId: 'com.example.app',
      deps: { normalizeDensity: async () => {} },
    });
    assert.equal(mockRunAppleRunnerCommand.mock.calls.length, 1);
    assert.equal(await fs.readFile(outPath, 'utf8'), 'default-fallback');
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});

test('resolveSimulatorRunnerScreenshotCandidatePaths includes tmp-based and basename fallbacks', () => {
  const containerPath = '/tmp/container';
  const candidates = resolveSimulatorRunnerScreenshotCandidatePaths(
    containerPath,
    '/var/mobile/Containers/Data/Application/abc/tmp/screenshot-1.png',
  );
  assert.equal(candidates.includes(path.join(containerPath, 'tmp', 'screenshot-1.png')), true);
  assert.equal(
    candidates.includes('/var/mobile/Containers/Data/Application/abc/tmp/screenshot-1.png'),
    true,
  );
});

test('resolveSimulatorRunnerScreenshotCandidatePaths handles empty runner path', () => {
  assert.deepEqual(resolveSimulatorRunnerScreenshotCandidatePaths('/tmp/container', '   '), []);
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
    await captureScreenshotViaRunner(device, firstPath);
    await captureScreenshotViaRunner(device, secondPath);

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

test('captureScreenshotViaRunner copies macOS runner screenshots from the host', async () => {
  const tmpDir = await mkdtempForTest('agent-device-macos-screenshot-');
  const sourcePath = path.join(tmpDir, 'runner.png');
  const outPath = path.join(tmpDir, 'screen.png');
  await fs.writeFile(sourcePath, 'runner-image', 'utf8');
  mockRunAppleRunnerCommand.mockResolvedValue({ message: sourcePath });
  mockRunCmd.mockRejectedValue(new Error('macOS screenshot must not invoke xcrun devicectl'));

  try {
    await captureScreenshotViaRunner(MACOS_TEST_DEVICE, outPath);
    assert.equal(await fs.readFile(outPath, 'utf8'), 'runner-image');
    assert.equal(mockRunCmd.mock.calls.length, 0);
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});
