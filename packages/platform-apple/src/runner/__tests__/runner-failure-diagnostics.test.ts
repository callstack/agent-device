import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { onTestFinished, test } from 'vitest';
import { AppError } from '@agent-device/kernel/errors';
import { captureRunnerLogOffset } from '../runner-failure-diagnostics.ts';
import { parseRunnerResponse } from '../runner-session.ts';
import { mkdtempForTestSync } from './tmp-dir.ts';

/**
 * One `runner.log` serves every command sent to one device and is never truncated between them
 * (#2683). Classifying a failure from the tail of that file therefore reads whatever the last
 * crashed command left behind and hands the blame to whoever failed next — a `snapshot` that timed
 * out two commands after an app crash used to be reported as that crash.
 *
 * The marker under test is where the log had reached when the command was sent, so only bytes this
 * command wrote can explain it.
 */

const AX_RUNTIME_CRASH = `Thread 0 Crashed::  Dispatch queue: com.apple.main-thread
0   libobjc.A.dylib                        objc_retain + 16
1   CoreText                               CreateFontWithFontURL(__CFURL const*, __CFString const*, __CFString const*) + 512
11  AXRuntime                              reconstitutedSmuggledCTFontFromDictionary + 192
`;

const FAILED_BODY = JSON.stringify({
  ok: false,
  error: { code: 'COMMAND_FAILED', message: 'Runner command timed out' },
});

test('a crash an earlier command wrote is not blamed on the command that failed next', async () => {
  const logPath = writeRunnerLog(AX_RUNTIME_CRASH);
  const logSince = await captureRunnerLogOffset(logPath);

  const error = await expectFailure(logPath, logSince);

  assert.equal(error.code, 'COMMAND_FAILED');
  assert.equal(error.details?.runnerFailureReason, undefined);
});

test('a crash this command wrote after the marker is still classified', async () => {
  // The marker must narrow what is read, not switch the reader off: without this control the
  // negative case above would pass by never reading the log at all.
  const logPath = writeRunnerLog('AGENT_DEVICE_RUNNER_COMMAND_START command=snapshot\n');
  const logSince = await captureRunnerLogOffset(logPath);
  fs.appendFileSync(logPath, AX_RUNTIME_CRASH);

  const error = await expectFailure(logPath, logSince);

  assert.equal(error.code, 'IOS_TARGET_APP_CRASH');
  assert.equal(error.details?.runnerFailureReason, 'target_app_axruntime_coretext_crash');
});

test('a log truncated behind the marker is not read at all', async () => {
  // A runner restarted under the command and rewrote its log, so the file is now shorter than the
  // byte this command started at. Nothing in it can be this command's, and guessing is worse than
  // staying silent (#2683).
  const logPath = writeRunnerLog(`${'x'.repeat(4096)}\n`);
  const logSince = await captureRunnerLogOffset(logPath);
  fs.writeFileSync(logPath, AX_RUNTIME_CRASH);

  const error = await expectFailure(logPath, logSince);

  assert.equal(error.details?.runnerFailureReason, undefined);
});

test('a log that does not exist yet is read from its first byte', async () => {
  const dir = mkdtempForTestSync('agent-device-runner-log-missing-');
  onTestFinished(() => fs.rmSync(dir, { recursive: true, force: true }));
  const logPath = path.join(dir, 'runner.log');
  const logSince = await captureRunnerLogOffset(logPath);
  assert.equal(logSince?.byteOffset, 0);
  fs.writeFileSync(logPath, AX_RUNTIME_CRASH);

  const error = await expectFailure(logPath, logSince);

  assert.equal(error.details?.runnerFailureReason, 'target_app_axruntime_coretext_crash');
});

test('a command with no log configured claims nothing from one', async () => {
  const error = await expectFailure(undefined, await captureRunnerLogOffset(undefined));

  assert.equal(error.code, 'COMMAND_FAILED');
  assert.equal(error.details?.runnerFailureReason, undefined);
});

async function expectFailure(
  logPath: string | undefined,
  logSince: Awaited<ReturnType<typeof captureRunnerLogOffset>>,
): Promise<AppError> {
  let caught: unknown;
  await assert.rejects(
    () => parseRunnerResponse(new Response(FAILED_BODY), { state: 'ready' }, logPath, logSince),
    (error: unknown) => {
      caught = error;
      return true;
    },
  );
  assert.ok(caught instanceof AppError);
  return caught;
}

function writeRunnerLog(contents: string): string {
  const dir = mkdtempForTestSync('agent-device-runner-log-');
  onTestFinished(() => fs.rmSync(dir, { recursive: true, force: true }));
  const logPath = path.join(dir, 'runner.log');
  fs.writeFileSync(logPath, contents);
  return logPath;
}
