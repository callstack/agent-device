import { test, vi } from 'vitest';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { bindTestCommandHost } from '@agent-device/test-kit';
import type { DeviceInfo } from '@agent-device/kernel/device';
import type { ExecResult } from '@agent-device/host-kit/command';

bindTestCommandHost();

// The retry loop runs for real; only its wait is removed, so no test sleeps through the
// production backoff. The policy, its predicate, and every command it issues stay the real ones.
vi.mock('@agent-device/host-kit/retry', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@agent-device/host-kit/retry')>();
  return { ...actual, retryWithPolicy: vi.fn(actual.retryWithPolicy) };
});

import { retryWithPolicy } from '@agent-device/host-kit/retry';
import {
  createLocalAppleToolProvider,
  withAppleToolProvider,
  SIMCTL_SCREENSHOT_TIMEOUT_REASON,
} from '../tool-provider.ts';
import { captureSimulatorScreenshotWithRetry } from '../screenshot.ts';
import { IOS_SIMULATOR_SCREENSHOT_STATE_PROBE_TIMEOUT_MS } from '../config.ts';
import { mkdtempForTest } from '../../__tests__/tmp-dir.ts';
import {
  commandFailed,
  commandStdout,
  isSimctlListDevices,
  isSimctlScreenshot,
  withScriptedCommands,
  type ScriptedCommandCall,
} from './scripted-command-executor.ts';

/**
 * The simulator screenshot retry loop, driven through the production local Apple tool provider.
 *
 * No `simctl` callback is supplied anywhere here, so every capture reaches the real local adapter
 * and the protocol parse that decides a retry is the one that ships.
 */

const SIMULATOR: DeviceInfo = {
  platform: 'apple',
  id: 'sim-retry',
  name: 'iPhone 17 Pro',
  kind: 'simulator',
};

/** simctl's top-level error protocol, rendered for a screenshot call whose surfaces never answered. */
const PROTOCOL_TIMEOUT =
  'An error was encountered processing the command (domain=NSPOSIXErrorDomain, code=60):\n' +
  "The operation couldn't be completed.\n" +
  'Timeout waiting for screen surfaces';

/** The wording a render-server stall printed, with no protocol header in front of it. */
const HEADERLESS_TIMEOUT =
  'Detected file type from extension: PNG\nTimeout waiting for screen surfaces\n';

const TINY_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);

/** Runs one attempt per round without waiting, keeping the real policy and predicate. */
function withoutBackoff(): void {
  vi.mocked(retryWithPolicy).mockImplementation(
    async (fn: Parameters<typeof retryWithPolicy>[0], policy, options) => {
      const maxAttempts = policy?.maxAttempts;
      assert.ok(
        typeof maxAttempts === 'number',
        'the capture retry must declare the budget this loop is bounded by',
      );
      let lastError: unknown;
      for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
        try {
          return await fn({ attempt, maxAttempts, deadline: options?.deadline });
        } catch (error) {
          lastError = error;
          if (!policy?.shouldRetry?.(error, attempt)) throw error;
        }
      }
      throw lastError;
    },
  );
}

/** Answers the scripted commands, failing this simulator's screenshot calls as `refuse` dictates. */
function screenshotRefusals(refuse: (attempt: number) => ExecResult | undefined, outPath: string) {
  let attempts = 0;
  return (call: ScriptedCommandCall): ExecResult => {
    if (!isSimctlScreenshot(call)) return commandStdout('');
    attempts += 1;
    const refusal = refuse(attempts);
    if (refusal) return refusal;
    // A capture that gets through writes the image file, the way the tool does.
    writeFileSync(outPath, TINY_PNG);
    return commandStdout('');
  };
}

async function captureThroughLocalAdapter(
  script: (call: ScriptedCommandCall) => ExecResult,
  outPath: string,
): Promise<{ error: unknown; calls: ScriptedCommandCall[]; attempts: number }> {
  return await withAppleToolProvider(
    createLocalAppleToolProvider(),
    async () =>
      await withScriptedCommands(script, async (executor) => {
        const error = await captureSimulatorScreenshotWithRetry(SIMULATOR, outPath, undefined).then(
          () => undefined,
          (error: unknown) => error,
        );
        const calls = executor.calls();
        return {
          error,
          calls,
          attempts: calls.filter(isSimctlScreenshot).length,
        };
      }),
  );
}

test.beforeEach(() => {
  vi.mocked(retryWithPolicy).mockRestore();
  withoutBackoff();
});

test('a protocol timeout the local adapter stamped is retried until the capture succeeds', async () => {
  const tmpDir = await mkdtempForTest('agent-device-screenshot-protocol-retry-');
  const outPath = path.join(tmpDir, 'screen.png');

  const { error, calls, attempts } = await captureThroughLocalAdapter(
    screenshotRefusals(
      (attempt) =>
        attempt === 1 ? commandFailed(PROTOCOL_TIMEOUT, 60, HEADERLESS_TIMEOUT) : undefined,
      outPath,
    ),
    outPath,
  );

  assert.equal(error, undefined);
  assert.equal(attempts, 2, 'the typed timeout is retried, and the second attempt wins');
  assert.equal(
    calls.filter(isSimctlScreenshot).every((call) => call.options.timeoutMs !== undefined),
    true,
    'every attempt carries its own exec budget',
  );
  // A capture budget is decided by the capture: the retry loop never reads the boot state.
  assert.equal(calls.filter(isSimctlListDevices).length, 0);
});

test('the retry loop stops at its declared attempt ceiling and reports the typed timeout', async () => {
  const tmpDir = await mkdtempForTest('agent-device-screenshot-protocol-exhaust-');
  const outPath = path.join(tmpDir, 'screen.png');

  const { error, attempts } = await captureThroughLocalAdapter(
    screenshotRefusals(() => commandFailed(PROTOCOL_TIMEOUT, 60), outPath),
    outPath,
  );

  assert.ok(error && error instanceof Error);
  const details = (error as { details?: Record<string, unknown> }).details;
  assert.equal(details?.reason, SIMCTL_SCREENSHOT_TIMEOUT_REASON);
  assert.equal(attempts, 5, 'the retry budget is the declared five attempts, no more');
});

test('identical timeout wording without the protocol header is terminal on the first attempt', async () => {
  const tmpDir = await mkdtempForTest('agent-device-screenshot-unattributed-');
  const outPath = path.join(tmpDir, 'screen.png');

  const { error, attempts } = await captureThroughLocalAdapter(
    screenshotRefusals(() => commandFailed(HEADERLESS_TIMEOUT, 60), outPath),
    outPath,
  );

  assert.ok(error instanceof Error);
  assert.match(error.message, /exited with code 60/);
  assert.equal(attempts, 1, 'wording the adapter did not attribute must not retry');
  assert.equal((error as { details?: Record<string, unknown> }).details?.reason, undefined);
});

test('an unrelated protocol code stays terminal and keeps the tool failure as reported', async () => {
  const tmpDir = await mkdtempForTest('agent-device-screenshot-einval-');
  const outPath = path.join(tmpDir, 'screen.png');

  const { error, attempts } = await captureThroughLocalAdapter(
    screenshotRefusals(
      () =>
        commandFailed(
          'An error was encountered processing the command (domain=NSPOSIXErrorDomain, code=22):\n' +
            'The operation couldn’t be completed. Invalid argument',
          149,
        ),
      outPath,
    ),
    outPath,
  );

  assert.ok(error instanceof Error);
  assert.equal(attempts, 1);
  assert.equal((error as { details?: Record<string, unknown> }).details?.reason, undefined);
});

test('the boot-state probe ceiling stays below the capture budget it explains', () => {
  // The probe is a best-effort read on the failure path, so it must be bounded under the operation
  // it follows; the inventory read's own 60s budget would invert that.
  assert.equal(IOS_SIMULATOR_SCREENSHOT_STATE_PROBE_TIMEOUT_MS, 5_000);
  assert.ok(IOS_SIMULATOR_SCREENSHOT_STATE_PROBE_TIMEOUT_MS < 20_000);
});
