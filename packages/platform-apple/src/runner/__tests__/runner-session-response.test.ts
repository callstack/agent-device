import { AppError } from '@agent-device/kernel/errors';
import { onTestFinished, test } from 'vitest';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import type { DiagnosticEventInput } from '@agent-device/host-kit/diagnostics';
import { mkdtempForTestSync } from './tmp-dir.ts';
import { appleRunnerTestHost } from '../test-host.ts';
import { isRetryableRunnerError } from '../runner-contract.ts';
import type { RunnerLogAttempt } from '../runner-failure-diagnostics.ts';
import { parseRunnerResponse } from '../runner-session.ts';

test('parseRunnerResponse preserves runner unsupported-operation codes', async () => {
  const response = new Response(
    JSON.stringify({
      ok: false,
      error: {
        code: 'UNSUPPORTED_OPERATION',
        message: 'Unable to dismiss the iOS keyboard without a safe native dismiss control',
      },
    }),
  );
  const session = { state: 'starting' } as const;

  await assert.rejects(
    () => parseRunnerResponse(response, session, runnerLogAttempt('/tmp/runner.log')),
    (error: unknown) => {
      assert.ok(error instanceof AppError);
      assert.equal(error.code, 'UNSUPPORTED_OPERATION');
      assert.match(error.message, /Unable to dismiss the iOS keyboard/i);
      return true;
    },
  );
});

test('parseRunnerResponse surfaces the keyboard-dismiss hint naming the occlusion reason', async () => {
  const hint =
    "An element whose center sits behind the on-screen keyboard is refused with tap_keyboard_occludes_target; one whose center stays above the keys presses normally. To end editing, tap the app's own Done/Cancel control, or use keyboard enter to press the return key when submission is wanted.";
  const response = new Response(
    JSON.stringify({
      ok: false,
      error: {
        code: 'UNSUPPORTED_OPERATION',
        message: 'Unable to dismiss the iOS keyboard without a safe native dismiss control',
        hint,
      },
    }),
  );
  const session = { state: 'starting' } as const;

  await assert.rejects(
    () => parseRunnerResponse(response, session, runnerLogAttempt('/tmp/runner.log')),
    (error: unknown) => {
      assert.ok(error instanceof AppError);
      assert.equal(error.code, 'UNSUPPORTED_OPERATION');
      assert.equal(error.details?.hint, hint);
      assert.match(String(error.details?.hint), /tap_keyboard_occludes_target/);
      assert.match(String(error.details?.hint), /center stays above the keys/i);
      assert.match(String(error.details?.hint), /keyboard enter/i);
      return true;
    },
  );
});

test('parseRunnerResponse preserves iOS AX snapshot failure code and hint', async () => {
  const hint =
    'Try a smaller read such as snapshot -s <visible label or id> -d 8, or use direct selector commands such as find id <value> click.';
  const response = new Response(
    JSON.stringify({
      ok: false,
      error: {
        code: 'IOS_AX_SNAPSHOT_FAILED',
        message: 'iOS XCTest snapshot failed with kAXErrorIllegalArgument.',
        hint,
      },
    }),
  );
  const session = { state: 'ready' } as const;

  await assert.rejects(
    () => parseRunnerResponse(response, session, runnerLogAttempt('/tmp/runner.log')),
    (error: unknown) => {
      assert.ok(error instanceof AppError);
      assert.equal(error.code, 'IOS_AX_SNAPSHOT_FAILED');
      assert.match(error.message, /kAXErrorIllegalArgument/);
      assert.equal(error.details?.hint, hint);
      assert.equal(isRetryableRunnerError(error), false);
      return true;
    },
  );
});

test('parseRunnerResponse preserves XCTest recorded failure code and hint', async () => {
  const hint =
    'The iOS runner session was invalidated. Re-observe with a fresh snapshot before retrying; if the accessibility tree is unavailable, use screenshot plus coordinate commands instead of retrying the tap blindly.';
  const response = new Response(
    JSON.stringify({
      ok: false,
      error: {
        code: 'XCTEST_RECORDED_FAILURE',
        message:
          'XCTest recorded a failure while executing tap; the action may not have been performed.',
        hint,
      },
    }),
  );
  const session = { state: 'ready' } as const;

  await assert.rejects(
    () => parseRunnerResponse(response, session, runnerLogAttempt('/tmp/runner.log')),
    (error: unknown) => {
      assert.ok(error instanceof AppError);
      assert.equal(error.code, 'XCTEST_RECORDED_FAILURE');
      assert.match(error.message, /may not have been performed/);
      assert.equal(error.details?.hint, hint);
      assert.equal(isRetryableRunnerError(error), false);
      return true;
    },
  );
});

test('parseRunnerResponse maps RUNNER_BUSY to retriable command failure', async () => {
  const hint = 'Wait a few seconds and retry.';
  const response = new Response(
    JSON.stringify({
      ok: false,
      error: {
        code: 'RUNNER_BUSY',
        message: 'The runner is still finishing abandoned work.',
        hint,
      },
    }),
  );
  const session = { state: 'ready' } as const;

  await assert.rejects(
    () => parseRunnerResponse(response, session, runnerLogAttempt('/tmp/runner.log')),
    (error: unknown) => {
      assert.ok(error instanceof AppError);
      assert.equal(error.code, 'COMMAND_FAILED');
      assert.equal(error.details?.runnerErrorCode, 'RUNNER_BUSY');
      assert.equal(error.details?.retriable, true);
      assert.equal(error.details?.hint, hint);
      assert.equal(isRetryableRunnerError(error), true);
      return true;
    },
  );
});

test('parseRunnerResponse preserves RUNNER_WEDGED as a fatal runner code', async () => {
  const response = new Response(
    JSON.stringify({
      ok: false,
      error: {
        code: 'RUNNER_WEDGED',
        message: 'The runner main thread is wedged.',
        hint: 'The runner session will be restarted.',
      },
    }),
  );
  const session = { state: 'ready' } as const;

  await assert.rejects(
    () => parseRunnerResponse(response, session, runnerLogAttempt('/tmp/runner.log')),
    (error: unknown) => {
      assert.ok(error instanceof AppError);
      assert.equal(error.code, 'RUNNER_WEDGED');
      assert.equal(error.details?.runnerErrorCode, 'RUNNER_WEDGED');
      assert.equal(isRetryableRunnerError(error), false);
      return true;
    },
  );
});

test('parseRunnerResponse classifies target app AXRuntime CoreText font crashes from runner log tail', async () => {
  const logPath = writeRunnerLogTail(`
Thread 0 Crashed::  Dispatch queue: com.apple.main-thread
0   libobjc.A.dylib                        objc_retain + 16
1   CoreText                               CreateFontWithFontURL(__CFURL const*, __CFString const*, __CFString const*) + 512
11  AXRuntime                              reconstitutedSmuggledCTFontFromDictionary + 192
12  AXRuntime                              -[NSDictionary(AXPropertyListCoersion) _axRecursivelyReconstitutedRepresentationFromPropertyListWithError:] + 156
`);
  const response = new Response(
    JSON.stringify({
      ok: false,
      error: {
        code: 'XCTEST_RECORDED_FAILURE',
        message:
          'XCTest recorded a failure while executing type; the action may not have been performed.',
      },
    }),
  );
  const session = { state: 'ready' } as const;

  await assert.rejects(
    () => parseRunnerResponse(response, session, runnerLogAttempt(logPath)),
    (error: unknown) => {
      assert.ok(error instanceof AppError);
      assert.equal(error.code, 'IOS_TARGET_APP_CRASH');
      assert.equal(error.details?.runnerFailureReason, 'target_app_axruntime_coretext_crash');
      assert.match(String(error.details?.hint), /AXRuntime read accessibility attributes/);
      assert.match(String(error.details?.hint), /latest stable simulator runtime/);
      assert.match(String(error.details?.hint), /exact command, selector\/ref/);
      return true;
    },
  );
});

test('parseRunnerResponse classifies explicit target app crashes from runner log tail', async () => {
  const logPath = writeRunnerLogTail(`
AGENT_DEVICE_RUNNER_COMMAND_FAILED command=snapshot
The application under test terminated unexpectedly.
`);
  const response = new Response(
    JSON.stringify({
      ok: false,
      error: {
        code: 'COMMAND_FAILED',
        message: 'Runner error',
      },
    }),
  );
  const session = { state: 'ready' } as const;

  await assert.rejects(
    () => parseRunnerResponse(response, session, runnerLogAttempt(logPath)),
    (error: unknown) => {
      assert.ok(error instanceof AppError);
      assert.equal(error.code, 'IOS_TARGET_APP_CRASH');
      assert.equal(error.details?.runnerFailureReason, 'target_app_crash');
      assert.match(String(error.details?.hint), /target iOS app appears to have crashed/);
      assert.equal(isRetryableRunnerError(error), false);
      return true;
    },
  );
});

test('parseRunnerResponse does not classify incidental XCTest crash text as target app crash', async () => {
  const logPath = writeRunnerLogTail(`
XCTest runner recovered from a previous test note: the word crashed appeared in debug output.
AGENT_DEVICE_RUNNER_COMMAND_FAILED command=snapshot error=fetch failed
`);
  const response = new Response(
    JSON.stringify({
      ok: false,
      error: {
        code: 'COMMAND_FAILED',
        message: 'fetch failed',
      },
    }),
  );
  const session = { state: 'ready' } as const;

  await assert.rejects(
    () => parseRunnerResponse(response, session, runnerLogAttempt(logPath)),
    (error: unknown) => {
      assert.ok(error instanceof AppError);
      assert.equal(error.code, 'COMMAND_FAILED');
      assert.equal(error.details?.runnerFailureReason, undefined);
      assert.equal(error.details?.hint, undefined);
      assert.equal(isRetryableRunnerError(error), true);
      return true;
    },
  );
});

test('parseRunnerResponse hints when XCTest main-thread execution times out', async () => {
  const logPath = writeRunnerLogTail(
    'AGENT_DEVICE_RUNNER_COMMAND_FAILED command=type error=main thread execution timed out',
  );
  const response = new Response(
    JSON.stringify({
      ok: false,
      error: {
        code: 'COMMAND_FAILED',
        message: 'main thread execution timed out',
      },
    }),
  );
  const session = { state: 'ready' } as const;

  await assert.rejects(
    () => parseRunnerResponse(response, session, runnerLogAttempt(logPath)),
    (error: unknown) => {
      assert.ok(error instanceof AppError);
      assert.equal(error.code, 'COMMAND_FAILED');
      assert.equal(error.details?.runnerFailureReason, 'runner_main_thread_execution_timeout');
      assert.match(String(error.details?.hint), /XCTest timed out waiting for main-thread work/);
      assert.match(String(error.details?.hint), /screenshot as visual truth/);
      assert.match(String(error.details?.hint), /coordinate presses/);
      return true;
    },
  );
});

test('parseRunnerResponse emits diagnostics for runner gesture fallbacks', async () => {
  const response = new Response(
    JSON.stringify({
      ok: true,
      data: {
        message: 'dragged',
        gestureFallback: 'xctest-coordinate-drag',
        gestureFallbackMessage: 'Runner synthesized drag is unavailable',
        gestureFallbackHint: 'Using XCTest coordinate drag fallback.',
      },
    }),
  );
  const session = { state: 'starting' } as const;
  const diagnosticEvents: DiagnosticEventInput[] = [];
  appleRunnerTestHost.update({ emitDiagnostic: (event) => diagnosticEvents.push(event) });

  const data = await parseRunnerResponse(response, session, runnerLogAttempt('/tmp/runner.log'));
  assert.equal(data.gestureFallback, 'xctest-coordinate-drag');

  assert.equal(session.state, 'ready');
  const diagnostics = JSON.stringify(diagnosticEvents);
  assert.match(diagnostics, /ios_runner_gesture_fallback/);
  assert.match(diagnostics, /xctest-coordinate-drag/);
});

/**
 * A log attempt over a log this test just created. Offset 0 is the honest boundary there: the file
 * holds nothing but this command's bytes, so everything in it may be read as this attempt's evidence.
 */
function runnerLogAttempt(logPath: string): RunnerLogAttempt {
  return { logPath, byteOffset: 0 };
}

function writeRunnerLogTail(contents: string): string {
  const dir = mkdtempForTestSync('agent-device-runner-log-');
  onTestFinished(() => fs.rmSync(dir, { recursive: true, force: true }));
  const logPath = path.join(dir, 'runner.log');
  fs.writeFileSync(logPath, contents);
  return logPath;
}
