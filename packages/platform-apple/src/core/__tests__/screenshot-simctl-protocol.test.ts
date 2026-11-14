import { test } from 'vitest';
import assert from 'node:assert/strict';
import { bindTestCommandHost } from '@agent-device/test-kit';
import { AppError } from '@agent-device/kernel/errors';
import type { DeviceInfo } from '@agent-device/kernel/device';
import type { ExecResult } from '@agent-device/host-kit/command';

bindTestCommandHost();

import {
  createLocalAppleToolProvider,
  runXcrun,
  withAppleToolProvider,
  SIMCTL_SCREENSHOT_TIMEOUT_REASON,
} from '../tool-provider.ts';
import { buildSimctlArgsForDevice } from '../simctl.ts';
import { shouldRetryIosSimulatorScreenshot } from '../screenshot.ts';
import {
  commandFailed,
  commandStdout,
  withScriptedCommands,
  type ScriptedCommandCall,
} from './scripted-command-executor.ts';

/**
 * The simctl screenshot protocol, read where it is produced.
 *
 * These run the production local Apple tool provider over the seam `runCmd` consults before it
 * spawns, so the adapter, its parse, and exec's own failure construction are the code under test.
 * The fake Apple tool provider supplies its own `simctl.run` and `runCommand`, which routes around
 * this adapter, so it cannot prove any of it.
 */

const SIMULATOR: DeviceInfo = {
  platform: 'apple',
  id: 'sim-1',
  name: 'iPhone 17 Pro',
  kind: 'simulator',
};

/** The screenshot command this flow builds, as `xcrun simctl` receives it after the tool name. */
const SCREENSHOT_ARGS = ['io', 'sim-1', 'screenshot', '/tmp/out.png'];

/** simctl's own top-level header, plus the CoreSimulator sentence it renders under it. */
function protocolTimeout(stderr = ''): string {
  return [
    'An error was encountered processing the command (domain=NSPOSIXErrorDomain, code=60):',
    "The operation couldn't be completed.",
    stderr || 'Timeout waiting for screen surfaces',
  ].join('\n');
}

function runScreenshot(options: { allowFailure?: boolean } = {}): Promise<ExecResult> {
  return runXcrun(buildSimctlArgsForDevice(SIMULATOR, SCREENSHOT_ARGS), {
    timeoutMs: 20_000,
    ...(options.allowFailure === undefined ? {} : { allowFailure: options.allowFailure }),
  });
}

/** Runs the screenshot call through the production local provider over scripted host commands. */
async function captureScreenshot(
  answer: (call: ScriptedCommandCall) => ExecResult,
): Promise<{ result?: ExecResult; error?: unknown; calls: ScriptedCommandCall[] }> {
  return await withAppleToolProvider(
    createLocalAppleToolProvider(),
    async () =>
      await withScriptedCommands(answer, async (executor) => {
        try {
          return { result: await runScreenshot(), calls: executor.calls() };
        } catch (error) {
          return { error, calls: executor.calls() };
        }
      }),
  );
}

function failedCommandError(error: unknown): AppError {
  assert.ok(error instanceof AppError, `expected an AppError, received: ${String(error)}`);
  return error;
}

function details(error: unknown): Record<string, unknown> {
  return (failedCommandError(error).details ?? {}) as Record<string, unknown>;
}

test('the local adapter stamps the screenshot protocol timeout as a typed reason', async () => {
  const { result, error, calls } = await captureScreenshot(() =>
    commandFailed(protocolTimeout(), 60, 'Detected file type from extension: PNG\n'),
  );

  assert.equal(result, undefined);
  const appError = failedCommandError(error);
  assert.equal(appError.code, 'COMMAND_FAILED');
  assert.equal(details(error).reason, SIMCTL_SCREENSHOT_TIMEOUT_REASON);
  assert.equal(shouldRetryIosSimulatorScreenshot(error), true);

  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.cmd, 'xcrun');
  assert.deepEqual(calls[0]?.args, ['simctl', ...SCREENSHOT_ARGS]);
});

test('the typed reason survives a changed human message and an unrelated exit code', async () => {
  // The header is the protocol; everything after it is prose the tool rewords between builds.
  const { error } = await captureScreenshot(() =>
    commandFailed(
      [
        'An error was encountered processing the command (domain=NSPOSIXErrorDomain, code=60):',
        'Rendering the display did not finish in time.',
      ].join('\n'),
      149,
    ),
  );

  assert.equal(details(error).reason, SIMCTL_SCREENSHOT_TIMEOUT_REASON);
  assert.equal(shouldRetryIosSimulatorScreenshot(error), true);
});

test.each(['\n', '\r\n'])(
  'a PNG diagnostic before the stderr header preserves typed retry with line ending %j',
  async (lineEnding) => {
    const stderr = [
      'Detected file type from extension: PNG',
      ...protocolTimeout().split('\n'),
    ].join(lineEnding);
    const { error } = await captureScreenshot(() => commandFailed(stderr, 60));

    assert.equal(details(error).stderr, stderr);
    assert.equal(details(error).reason, SIMCTL_SCREENSHOT_TIMEOUT_REASON);
    assert.equal(shouldRetryIosSimulatorScreenshot(error), true);
  },
);

test('the adapter accepts a leading protocol header with CRLF line endings', async () => {
  const { error } = await captureScreenshot(() =>
    commandFailed(protocolTimeout().replaceAll('\n', '\r\n'), 60),
  );

  assert.equal(details(error).reason, SIMCTL_SCREENSHOT_TIMEOUT_REASON);
  assert.equal(shouldRetryIosSimulatorScreenshot(error), true);
});

test('the adapter keeps every exec failure detail beside the reason it stamped', async () => {
  const { error } = await captureScreenshot(() =>
    commandFailed(protocolTimeout(), 60, 'Detected file type from extension: PNG\n'),
  );

  const commandDetails = details(error);
  assert.equal(commandDetails.exitCode, 60);
  assert.equal(commandDetails.processExitError, true);
  assert.equal(commandDetails.cmd, 'xcrun');
  assert.deepEqual(commandDetails.args, ['simctl', ...SCREENSHOT_ARGS]);
  assert.equal(
    commandDetails.stderr,
    'An error was encountered processing the command (domain=NSPOSIXErrorDomain, code=60):\n' +
      "The operation couldn't be completed.\nTimeout waiting for screen surfaces",
  );
  assert.equal(commandDetails.stdout, 'Detected file type from extension: PNG\n');
});

test('the adapter reads the protocol header for a set-scoped screenshot call', async () => {
  const scopedDevice: DeviceInfo = { ...SIMULATOR, simulatorSetPath: '/tmp/tenant/set' };
  const outcome = await withAppleToolProvider(
    createLocalAppleToolProvider(),
    async () =>
      await withScriptedCommands(
        () => commandFailed(protocolTimeout(), 60),
        async () => {
          try {
            return await runXcrun(buildSimctlArgsForDevice(scopedDevice, SCREENSHOT_ARGS), {
              timeoutMs: 20_000,
            });
          } catch (error) {
            return { error };
          }
        },
      ),
  );

  assert.ok('error' in outcome, 'the scoped screenshot command must fail');
  assert.equal(details(outcome.error).reason, SIMCTL_SCREENSHOT_TIMEOUT_REASON);
});

test('the same screenshot text without the protocol header stays unattributed', async () => {
  // Identical message, stdout, stderr and argv as the positive above, minus the header line: this
  // is the case the text classifier used to accept, and the one that must stay terminal.
  const { error } = await captureScreenshot(() =>
    commandFailed(
      'Detected file type from extension: PNG\nTimeout waiting for screen surfaces\n',
      60,
    ),
  );

  const appError = failedCommandError(error);
  assert.equal(appError.code, 'COMMAND_FAILED');
  assert.equal(appError.message, 'xcrun exited with code 60');
  assert.equal(details(error).reason, undefined);
  assert.equal(shouldRetryIosSimulatorScreenshot(error), false);
});

test('the adapter ignores a header whose domain or code is not the screenshot timeout', async () => {
  const unrelatedHeaders = [
    // EINVAL, the refusal a screenshot request gets from a display argument it cannot honour.
    'An error was encountered processing the command (domain=NSPOSIXErrorDomain, code=22):',
    // ESRCH, printed by the same protocol on another path.
    'An error was encountered processing the command (domain=NSPOSIXErrorDomain, code=3):',
    // A CoreSimulator state answer: a different domain, and no screenshot contract at all.
    'An error was encountered processing the command (domain=com.apple.CoreSimulator.SimError, code=405):',
    // The POSIX domain with a code that is not 60, and a code that merely starts with 60.
    'An error was encountered processing the command (domain=NSPOSIXErrorDomain, code=600):',
    'An error was encountered processing the command (domain=NSPOSIXErrorDomain, code=-60):',
    // Malformed protocol: the header states no number.
    'An error was encountered processing the command (domain=NSPOSIXErrorDomain, code=):',
    'An error was encountered processing the command (domain=NSPOSIXErrorDomain, code=ETIMEDOUT):',
  ];

  for (const stderr of unrelatedHeaders) {
    const { error } = await captureScreenshot(() =>
      commandFailed(`${stderr}\nThe operation couldn't be completed.`, 149),
    );

    assert.equal(
      details(error).reason,
      undefined,
      `must not attribute a screenshot timeout: ${stderr}`,
    );
    assert.equal(shouldRetryIosSimulatorScreenshot(error), false, `must stay terminal: ${stderr}`);
  }
});

test('the adapter ignores a header that simctl did not print at the top level', async () => {
  const nestedOnly = [
    'An error was encountered processing the command (domain=com.apple.CoreSimulator.SimError, code=405):',
    'Unable to lookup in current state: Shutdown',
    '    Underlying error (domain=NSPOSIXErrorDomain, code=60):',
    'Timeout waiting for screen surfaces',
  ].join('\n');

  const stdoutOnly = `${protocolTimeout()}\n`;
  const cases: Array<[string, () => ExecResult]> = [
    ['nested underlying-error header only', () => commandFailed(nestedOnly, 149)],
    ['header printed on stdout instead of stderr', () => commandFailed('', 60, stdoutOnly)],
    [
      'indented matching header after a diagnostic preamble',
      () => commandFailed(`Detected file type from extension: PNG\n    ${protocolTimeout()}`, 60),
    ],
    [
      'matching header after an unrelated top-level error',
      () => commandFailed(`${nestedOnly}\n${protocolTimeout()}`, 149),
    ],
  ];

  for (const [label, answer] of cases) {
    const { error } = await captureScreenshot(answer);

    assert.equal(details(error).reason, undefined, label);
    assert.equal(shouldRetryIosSimulatorScreenshot(error), false, label);
  }
});

test('the adapter attributes nothing for a screenshot call that succeeded', async () => {
  const { result, error } = await captureScreenshot(() => commandStdout(''));

  assert.equal(error, undefined);
  assert.equal(result?.exitCode, 0);
});

test('the adapter leaves a caller-supplied command executor unclassified', async () => {
  // A host that supplies its own `runCommand` owns its errors: the local parse does not run over a
  // callback it does not control, so its protocol-looking failure stays unknown.
  const supplied = async (): Promise<ExecResult> => {
    throw new AppError('COMMAND_FAILED', 'remote screenshot failed', {
      stderr: protocolTimeout(),
      exitCode: 60,
      args: ['xcrun', 'simctl', ...SCREENSHOT_ARGS],
    });
  };

  const error = await withAppleToolProvider(
    createLocalAppleToolProvider({ runCommand: supplied }),
    async () =>
      await withScriptedCommands(
        () => commandStdout(''),
        async () =>
          await runScreenshot().then(
            () => null,
            (error: unknown) => error,
          ),
      ),
  );

  assert.ok(error instanceof AppError);
  assert.equal(error.message, 'remote screenshot failed');
  assert.equal(details(error).reason, undefined);
  assert.equal(shouldRetryIosSimulatorScreenshot(error), false);
});

test('the adapter leaves a caller-supplied simctl runner unclassified', async () => {
  // A host that supplies `simctl.run` owns its own failure reporting: the local parse never sees what
  // that callback answers, so a protocol-shaped failure crosses over untouched and names no reason.
  const suppliedFailure = new AppError('COMMAND_FAILED', 'simctl screenshot failed', {
    exitCode: 60,
    stderr: protocolTimeout(),
  });
  const error = await withAppleToolProvider(
    createLocalAppleToolProvider({
      simctl: {
        run: async () => {
          throw suppliedFailure;
        },
      },
    }),
    async () =>
      await withScriptedCommands(
        () => commandStdout(''),
        async () =>
          await runScreenshot().then(
            () => null,
            (error: unknown) => error,
          ),
      ),
  );

  assert.equal(error, suppliedFailure, "the supplied callback's own error is what surfaces");
  assert.equal(details(error).reason, undefined);
  assert.equal(shouldRetryIosSimulatorScreenshot(error), false);
});

test('the adapter does not parse a simctl subcommand it did not scope as a screenshot', async () => {
  const otherSubcommands = [
    ['status_bar', ['status_bar', 'sim-1', 'list']],
    ['getenv', ['getenv', 'sim-1', 'SIMULATOR_MAINSCREEN_SCALE']],
    ['boot', ['boot', 'sim-1']],
  ] as const;

  for (const [label, args] of otherSubcommands) {
    const outcome = await withAppleToolProvider(
      createLocalAppleToolProvider(),
      async () =>
        await withScriptedCommands(
          () => commandFailed(protocolTimeout(), 60),
          async () =>
            await runXcrun(buildSimctlArgsForDevice(SIMULATOR, [...args]), {
              timeoutMs: 20_000,
            }).then(
              (result) => ({ result }),
              (error: unknown) => ({ error }),
            ),
        ),
    );

    assert.ok('error' in outcome, `${label} must report the scripted command failure`);
    assert.equal(
      details(outcome.error).reason,
      undefined,
      `a ${label} failure is not a screenshot timeout`,
    );
  }
});

test('the adapter leaves an allowFailure screenshot call untouched', async () => {
  // A caller that asked to read the failure itself gets the tool's raw result, not an error.
  const { result, error } = await withAppleToolProvider(
    createLocalAppleToolProvider(),
    async () =>
      await withScriptedCommands(
        () => commandFailed(protocolTimeout(), 60),
        async (executor) => {
          try {
            return { result: await runScreenshot({ allowFailure: true }), calls: executor.calls() };
          } catch (error) {
            return { error };
          }
        },
      ),
  );

  assert.equal(error, undefined);
  assert.equal(result?.exitCode, 60);
});
