import assert from 'node:assert/strict';
import { test } from 'vitest';
import { AppError, createRequestCanceledError } from '@agent-device/kernel/errors';
import {
  COMMAND_ALREADY_FINISHED_RUNNER_CODE,
  HARDWARE_CONTROL_UNAVAILABLE_RUNNER_CODE,
  IN_APP_BACK_CONTROL_UNAVAILABLE_RUNNER_CODE,
  KEYBOARD_DISMISS_UNAVAILABLE_RUNNER_CODE,
  KEYBOARD_RETURN_UNAVAILABLE_RUNNER_CODE,
  MAIN_THREAD_TIMEOUT_RUNNER_CODE,
  NO_TEXT_INPUT_AT_POINT_RUNNER_CODE,
  RUNNER_SCREEN_CAPTURE_REFUSAL_RUNNER_CODES,
  TEXT_INPUT_PROBE_UNAVAILABLE_RUNNER_CODE,
  classifyRunnerReportedError,
} from '../runner-contract.ts';
import {
  RUNNER_ERROR_RULES,
  RUNNER_REPLY_LOST_REASON,
  isRetryableRunnerError,
  isRunnerBusyError,
  resolveRunnerFatalErrorReason,
  runnerMainThreadOccupancyReport,
  shouldRebuildCachedRunnerArtifact,
  shouldRestartRunnerAfterReadinessPreflight,
  shouldRestartRunnerBeforeCommandSend,
  shouldRetryRunnerConnectError,
} from '../runner-error-classification.ts';
import { runnerConnectFailure, unwrittenConnectRefusal } from './runner-session-fixtures.ts';
import {
  requireSwiftControlRefusalWireCodes,
  requireSwiftKeyboardDismissRefusalWireCode,
  requireSwiftThrownErrorWireCode,
} from './runner-swift-settlement-fixtures.ts';

const TAP = { command: 'tap' } as const;
const SNAPSHOT = { command: 'snapshot' } as const;

function commandFailed(message: string, details?: Record<string, unknown>): AppError {
  return new AppError('COMMAND_FAILED', message, details);
}

test('every rule carries a unique reason', () => {
  const reasons = RUNNER_ERROR_RULES.map((rule) => rule.reason);
  assert.equal(new Set(reasons).size, reasons.length);
});

// --- retryable axis (isRetryableRunnerError) ---

test('transport-shaped failures are retryable', () => {
  assert.equal(
    isRetryableRunnerError(
      runnerConnectFailure(
        'runner_connect_refused',
        'Runner did not accept connection on port 8100',
      ),
    ),
    true,
  );
  for (const message of ['fetch failed', 'connect ECONNREFUSED 127.0.0.1:8100', 'socket hang up']) {
    assert.equal(isRetryableRunnerError(commandFailed(message)), true, message);
  }
});

test('a lost reply keys on its typed reason, never on the transport text it carries', () => {
  for (const message of ['fetch failed', 'connect ECONNREFUSED 127.0.0.1:8100', 'socket hang up']) {
    const lostReply = commandFailed(message, { reason: RUNNER_REPLY_LOST_REASON });
    assert.equal(isRetryableRunnerError(lostReply), false, message);
    assert.equal(shouldRetryRunnerConnectError(lostReply), false, message);
    assert.equal(shouldRestartRunnerBeforeCommandSend(lostReply, TAP), false, message);
  }
});

test('boot-shaped failures are not retryable', () => {
  assert.equal(
    isRetryableRunnerError(
      runnerConnectFailure(
        'xcodebuild_exited_early',
        'Runner did not accept connection (xcodebuild exited early)',
      ),
    ),
    false,
  );
  assert.equal(
    isRetryableRunnerError(commandFailed('Device is busy (Connecting to Simulator)')),
    false,
  );
});

test('only the runner busy refusal earns a resend; a retriable flag alone does not', () => {
  const busy = classifyRunnerReportedError('RUNNER_BUSY');
  assert.equal(isRetryableRunnerError(new AppError(busy.code, 'busy', busy.details)), true);
  const notRunning = classifyRunnerReportedError('APP_NOT_RUNNING');
  assert.equal(notRunning.details.retriable, true);
  assert.equal(
    isRetryableRunnerError(new AppError(notRunning.code, 'not running', notRunning.details)),
    false,
  );
  assert.equal(isRetryableRunnerError(commandFailed('boom', { retriable: true })), false);
});

test('the main-thread runner codes publish details.reason beside details.runnerErrorCode', () => {
  const busy = classifyRunnerReportedError('RUNNER_BUSY');
  assert.equal(busy.code, 'COMMAND_FAILED');
  assert.equal(busy.details.runnerErrorCode, 'RUNNER_BUSY');
  assert.equal(busy.details.reason, 'runner_busy');
  const timeout = classifyRunnerReportedError('MAIN_THREAD_TIMEOUT');
  assert.equal(timeout.code, 'COMMAND_FAILED');
  assert.equal(timeout.details.runnerErrorCode, 'MAIN_THREAD_TIMEOUT');
  assert.equal(timeout.details.reason, 'runner_main_thread_timeout');
  assert.equal(classifyRunnerReportedError('APP_NOT_RUNNING').details.reason, undefined);
});

// The literal is what the Swift runner encodes, so it is the contract and not the constant name:
// a rename on one side has to fail here rather than silently split the pair.
test('a coordinate fill refused for a point with no input keeps its code and publishes its reason', () => {
  assert.equal(NO_TEXT_INPUT_AT_POINT_RUNNER_CODE, 'NO_TEXT_INPUT_AT_POINT');
  const refusal = classifyRunnerReportedError(NO_TEXT_INPUT_AT_POINT_RUNNER_CODE);
  assert.equal(refusal.code, 'NO_TEXT_INPUT_AT_POINT');
  assert.equal(refusal.details.reason, 'no_text_input_at_point');
  assert.equal(refusal.details.dispatched, 'no');
  assert.equal(refusal.details.retriable, undefined);
  // The refusal ran nothing, so it is a definite answer and never a resend.
  const refusalError = new AppError(refusal.code, refusal.details.reason ?? '', refusal.details);
  assert.equal(isRetryableRunnerError(refusalError), false);
  assert.equal(isRunnerBusyError(refusalError), false);
  // The closest negative: the same words from an unclassified failure earn no reason, so a
  // consumer keyed on `reason` cannot mistake a reply that may have landed for this refusal.
  const untyped = commandFailed('no text input identified at the provided coordinates');
  assert.equal(untyped.details?.reason, undefined);
  assert.equal(isRetryableRunnerError(untyped), false);
});

// The two coordinate-fill refusals answer different questions and must never collapse into one
// another: an empty point is a fact about the screen, a blind lookup is a fact about the channel.
test('a coordinate fill refused on an unreadable point reports its own code, not no-input', () => {
  assert.equal(TEXT_INPUT_PROBE_UNAVAILABLE_RUNNER_CODE, 'TEXT_INPUT_PROBE_UNAVAILABLE');
  const refusal = classifyRunnerReportedError(TEXT_INPUT_PROBE_UNAVAILABLE_RUNNER_CODE);
  assert.equal(refusal.code, 'TEXT_INPUT_PROBE_UNAVAILABLE');
  assert.equal(refusal.details.reason, 'text_input_probe_unavailable');
  assert.equal(refusal.details.dispatched, 'no');
  assert.notEqual(
    refusal.details.reason,
    classifyRunnerReportedError(NO_TEXT_INPUT_AT_POINT_RUNNER_CODE).details.reason,
  );
  assert.equal(isRetryableRunnerError(new AppError(refusal.code, '', refusal.details)), false);
});

// The literals are what the Swift runner encodes. Only a gesture refused before any event reached
// XCTest proves the command sent nothing; one that failed after may have run.
test('a synthesized gesture refusal is not dispatched; a failure after hand-off stays unknown', () => {
  const refused = classifyRunnerReportedError('SYNTHESIZED_GESTURE_NOT_DISPATCHED');
  assert.equal(refused.code, 'COMMAND_FAILED');
  assert.equal(refused.details.reason, 'synthesized_gesture_not_dispatched');
  assert.equal(refused.details.dispatched, 'no');
  const unknown = classifyRunnerReportedError('SYNTHESIZED_GESTURE_OUTCOME_UNKNOWN');
  assert.equal(unknown.code, 'COMMAND_FAILED');
  assert.equal(unknown.details.reason, 'synthesized_gesture_outcome_unknown');
  assert.equal(unknown.details.dispatched, 'unknown');
  assert.equal(isRetryableRunnerError(new AppError(unknown.code, '', unknown.details)), false);
});

// The literals are what the Swift runner encodes. A back swipe that ran keeps an unknown dispatch
// whether the screen stayed the same or could not be sampled; only the reason tells them apart.
test('a back swipe that proved nothing stays COMMAND_FAILED, unknown, with its own reason', () => {
  const unchanged = classifyRunnerReportedError('BACK_SWIPE_NO_CHANGE');
  assert.equal(unchanged.code, 'COMMAND_FAILED');
  assert.equal(unchanged.details.reason, 'back_swipe_no_change');
  assert.equal(unchanged.details.dispatched, 'unknown');
  const unverified = classifyRunnerReportedError('BACK_SWIPE_UNVERIFIED');
  assert.equal(unverified.code, 'COMMAND_FAILED');
  assert.equal(unverified.details.reason, 'back_swipe_unverified');
  assert.equal(unverified.details.dispatched, 'unknown');
  // A swipe refused before touch-down reached nothing, so it is the one back refusal that is `no`.
  const notDispatched = classifyRunnerReportedError('BACK_SWIPE_NOT_DISPATCHED');
  assert.equal(notDispatched.code, 'COMMAND_FAILED');
  assert.equal(notDispatched.details.reason, 'back_swipe_not_dispatched');
  assert.equal(notDispatched.details.dispatched, 'no');
});

// The keyboard stays up two different ways, and only one of them sent nothing. The literal is what the
// Swift runner encodes, so it is the contract and not the constant name: a rename on one side has to
// fail here rather than silently split the pair.
test('a keyboard dismiss refused for having no dismiss key keeps its code and publishes its reason', () => {
  assert.equal(KEYBOARD_DISMISS_UNAVAILABLE_RUNNER_CODE, 'KEYBOARD_DISMISS_UNAVAILABLE');
  const refusal = classifyRunnerReportedError(KEYBOARD_DISMISS_UNAVAILABLE_RUNNER_CODE);
  // The code contract for `keyboard dismiss` is unchanged: the refusal travels under the code that
  // command already refused with, so a caller keyed on the code sees what it saw before.
  assert.equal(refusal.code, 'UNSUPPORTED_OPERATION');
  assert.equal(refusal.details.runnerErrorCode, 'KEYBOARD_DISMISS_UNAVAILABLE');
  assert.equal(refusal.details.reason, 'keyboard_dismiss_unavailable');
  assert.equal(refusal.details.dispatched, 'no');
  assert.equal(refusal.details.retriable, undefined);
  // The whole published shape: the runner's own code survives, the wire code it hides under does not.
  assert.deepEqual(refusal.details, {
    runnerErrorCode: 'KEYBOARD_DISMISS_UNAVAILABLE',
    reason: 'keyboard_dismiss_unavailable',
    dispatched: 'no',
  });
  const refusalError = new AppError(refusal.code, refusal.details.reason ?? '', refusal.details);
  assert.equal(isRetryableRunnerError(refusalError), false);
  assert.equal(isRunnerBusyError(refusalError), false);
  // The closest negative: the same refusal in prose alone, from an unclassified reply, earns no
  // reason, so a consumer keyed on `reason` cannot mistake it for the pre-dispatch refusal.
  const untyped = commandFailed(
    'Unable to dismiss the keyboard: it exposes no dismiss key, and background taps are never attempted',
  );
  assert.equal(untyped.details?.reason, undefined);
  // A dismiss control that was tapped and left the keys up did dispatch, so it keeps the generic code
  // and says nothing about dispatch.
  const dispatched = classifyRunnerReportedError('UNSUPPORTED_OPERATION');
  assert.equal(dispatched.code, 'UNSUPPORTED_OPERATION');
  assert.equal(dispatched.details.reason, undefined);
  assert.equal(dispatched.details.dispatched, 'unknown');
});

// Three more refusals a caller could only tell apart by reading `message`. Each keeps the code its
// command already refused with, so only `details.reason` is added; the two that provably pressed
// nothing disclose `no`, and `keyboard enter` cannot, because its sole-field route taps the field
// before typing.
test('the hardware-control refusal keeps UNSUPPORTED_OPERATION and says nothing was pressed', () => {
  assert.equal(HARDWARE_CONTROL_UNAVAILABLE_RUNNER_CODE, 'HARDWARE_CONTROL_UNAVAILABLE');
  const refusal = classifyRunnerReportedError(HARDWARE_CONTROL_UNAVAILABLE_RUNNER_CODE);
  assert.equal(refusal.code, 'UNSUPPORTED_OPERATION');
  assert.deepEqual(refusal.details, {
    runnerErrorCode: 'HARDWARE_CONTROL_UNAVAILABLE',
    reason: 'hardware_control_unavailable',
    dispatched: 'no',
  });
  // The closest negative: the same sentence with no code earns no reason, so a consumer keyed on
  // `reason` cannot mistake prose for the typed refusal.
  const untyped = commandFailed('actionButton requires a device model with an Action Button');
  assert.equal(untyped.details?.reason, undefined);
});

test('the keyboard-return refusal keeps UNSUPPORTED_OPERATION and reports an unknown dispatch', () => {
  assert.equal(KEYBOARD_RETURN_UNAVAILABLE_RUNNER_CODE, 'KEYBOARD_RETURN_UNAVAILABLE');
  const refusal = classifyRunnerReportedError(KEYBOARD_RETURN_UNAVAILABLE_RUNNER_CODE);
  assert.equal(refusal.code, 'UNSUPPORTED_OPERATION');
  // The refusal says nothing about dispatch: the sole-text-field route taps the field before typing the
  // return, so a refusal can follow a tap that landed.
  assert.deepEqual(refusal.details, {
    runnerErrorCode: 'KEYBOARD_RETURN_UNAVAILABLE',
    reason: 'keyboard_return_unavailable',
    dispatched: 'unknown',
  });
  // The closest negative: the same sentence with no code earns no reason, so a consumer keyed on
  // `reason` cannot mistake prose for the typed refusal.
  const untyped = commandFailed(
    'Unable to press the keyboard return key: the keyboard exposes no return-like key and no text field was available to submit',
  );
  assert.equal(untyped.details?.reason, undefined);
});

test('the macOS in-app back refusal publishes its reason under the code a code-less reply had', () => {
  assert.equal(IN_APP_BACK_CONTROL_UNAVAILABLE_RUNNER_CODE, 'IN_APP_BACK_CONTROL_UNAVAILABLE');
  const refusal = classifyRunnerReportedError(IN_APP_BACK_CONTROL_UNAVAILABLE_RUNNER_CODE);
  // That reply carried no code, so the host read COMMAND_FAILED; naming it must not move the command
  // to a code its callers never saw.
  assert.equal(refusal.code, 'COMMAND_FAILED');
  assert.deepEqual(refusal.details, {
    runnerErrorCode: 'IN_APP_BACK_CONTROL_UNAVAILABLE',
    reason: 'in_app_back_control_unavailable',
    dispatched: 'no',
  });
  // The closest negative: the base reply was a code-less COMMAND_FAILED, and prose alone still earns no
  // reason, so a consumer keyed on `reason` cannot mistake it for the typed refusal.
  const untyped = commandFailed('in-app back control is not available');
  assert.equal(untyped.details?.reason, undefined);
});

test('retryable requires an AppError with COMMAND_FAILED', () => {
  assert.equal(isRetryableRunnerError(new Error('fetch failed')), false);
  assert.equal(isRetryableRunnerError(new AppError('DEVICE_NOT_FOUND', 'fetch failed')), false);
});

// --- connect-retry axis (shouldRetryRunnerConnectError) ---

test('connect loop keeps waiting by default, including for unknown errors', () => {
  assert.equal(
    shouldRetryRunnerConnectError(
      runnerConnectFailure('runner_connect_refused', 'Runner did not accept connection'),
    ),
    true,
  );
  assert.equal(shouldRetryRunnerConnectError(new Error('anything')), true);
  assert.equal(shouldRetryRunnerConnectError(new AppError('INVALID_ARGS', 'nope')), true);
});

test('connect loop stops for terminal verdicts', () => {
  assert.equal(
    shouldRetryRunnerConnectError(
      runnerConnectFailure('xcodebuild_exited_early', 'xcodebuild exited early'),
    ),
    false,
  );
  for (const reason of ['runner_session_draining', 'runner_session_stopped'] as const) {
    const terminal = runnerConnectFailure(reason);
    assert.equal(shouldRetryRunnerConnectError(terminal), false, reason);
    assert.equal(isRetryableRunnerError(terminal), false, reason);
    assert.equal(shouldRebuildCachedRunnerArtifact(terminal), false, reason);
    assert.equal(shouldRestartRunnerBeforeCommandSend(terminal, TAP), false, reason);
  }
  const unattached = new AppError('DEVICE_NOT_FOUND', 'device not attached', {
    usbmuxDeviceAttached: false,
  });
  assert.equal(shouldRetryRunnerConnectError(unattached), false);
  // The same code without the usbmux evidence keeps waiting.
  assert.equal(shouldRetryRunnerConnectError(new AppError('DEVICE_NOT_FOUND', 'gone')), true);
});

// --- readiness preflight ---

test('the preflight marker alone decides the restart', () => {
  // The marker is applied by the preflight's own catch, whatever it was waiting on when it gave
  // up: a killed fallback, an exhausted probe, a refusal. Which of those arrived is not evidence
  // about whether the command reached the runner, and the marker is.
  const killedSpawn = commandFailed('xcrun timed out after 45000ms', {
    cmd: 'xcrun',
    timeoutMs: 45_000,
    runnerReadinessPreflightFailed: true,
  });
  assert.equal(shouldRestartRunnerAfterReadinessPreflight(killedSpawn), true);
  assert.equal(
    shouldRestartRunnerAfterReadinessPreflight(
      commandFailed('Runner readiness refused', { runnerReadinessPreflightFailed: true }),
    ),
    true,
  );
  // The restart the marker authorises is a new session, not more waiting inside this one.
  assert.equal(shouldRetryRunnerConnectError(killedSpawn), true);
  // Without the marker the same two shapes say nothing about the command having been written.
  assert.equal(
    shouldRestartRunnerAfterReadinessPreflight(
      commandFailed('xcrun timed out after 45000ms', { cmd: 'xcrun', timeoutMs: 45_000 }),
    ),
    false,
  );
  assert.equal(
    shouldRestartRunnerAfterReadinessPreflight(commandFailed('Runner readiness refused')),
    false,
  );
  // The same catch marks a caller that stopped waiting. That mark is not a runner that stopped
  // answering: the command was canceled, so no restart has a request left to serve.
  assert.equal(
    shouldRestartRunnerAfterReadinessPreflight(
      createRequestCanceledError({ runnerReadinessPreflightFailed: true }),
    ),
    false,
  );
});

test('a deadline on its own earns no recovery verdict', () => {
  // The same recorded budget covers a wait inside the connect loop, where waiting is
  // right, and a fetch that died after the command was written, where replaying is not.
  const deadline = commandFailed('Runner command deadline exceeded', {
    port: 8100,
    timeoutMs: 45_000,
  });
  assert.equal(isRetryableRunnerError(deadline), false);
  assert.equal(shouldRestartRunnerBeforeCommandSend(deadline, SNAPSHOT), false);
  assert.equal(shouldRestartRunnerAfterReadinessPreflight(deadline), false);
  assert.equal(shouldRebuildCachedRunnerArtifact(deadline), false);
  assert.equal(shouldRetryRunnerConnectError(deadline), true);
});

// --- restored-artifact axis (shouldRebuildCachedRunnerArtifact) ---

test('only a runner that never accepted a connection indicts the cached artifact', () => {
  assert.equal(
    shouldRebuildCachedRunnerArtifact(
      runnerConnectFailure('runner_endpoint_probe_exhausted', 'Runner endpoint probe failed'),
    ),
    true,
  );
  assert.equal(
    shouldRebuildCachedRunnerArtifact(
      runnerConnectFailure('runner_connect_refused', 'Runner did not accept connection'),
    ),
    true,
  );
  // Wiping derived data cannot fix a boot that refuses to compile.
  assert.equal(
    shouldRebuildCachedRunnerArtifact(
      runnerConnectFailure(
        'xcodebuild_exited_early',
        'Runner did not accept connection (xcodebuild exited early)',
        { port: 8100, logPath: '/tmp/runner.log' },
      ),
    ),
    false,
  );
  assert.equal(shouldRebuildCachedRunnerArtifact(commandFailed('fetch failed')), false);
});

test('a simulator service this macOS refuses to load is terminal on every recovery axis', () => {
  // The reason the launch paths publish is the whole fact: this Xcode fails every launch on this
  // macOS, so no restart, resend, replay, or clean rebuild may be ordered for it (#3449).
  const blessRefusal = commandFailed('Runner did not accept connection', {
    reason: 'simulator_service_hub_unavailable',
    runnerConnectFailureReason: 'runner_connect_refused',
    dispatched: 'no',
  });
  assert.equal(shouldRetryRunnerConnectError(blessRefusal), false);
  assert.equal(isRetryableRunnerError(blessRefusal), false);
  assert.equal(shouldRestartRunnerBeforeCommandSend(blessRefusal, SNAPSHOT), false);
  assert.equal(shouldRebuildCachedRunnerArtifact(blessRefusal), false);
  // The preflight's restart marker cannot outvote it either: the preflight would boot the same
  // runner that just failed to load its service hub.
  assert.equal(
    shouldRestartRunnerAfterReadinessPreflight(
      commandFailed('Runner readiness refused', {
        reason: 'simulator_service_hub_unavailable',
        runnerReadinessPreflightFailed: true,
      }),
    ),
    false,
  );
});

test('a refused connection still restarts and rebuilds without the service-hub reason', () => {
  // The closest negative: the same connect-shaped failure a host with a supported Xcode produces.
  const refused = unwrittenConnectRefusal();
  assert.equal(shouldRetryRunnerConnectError(refused), true);
  assert.equal(shouldRestartRunnerBeforeCommandSend(refused, TAP), true);
  assert.equal(shouldRebuildCachedRunnerArtifact(refused), true);
});

test('a scoped-set destination this Xcode cannot resolve is terminal on every recovery axis', () => {
  // The other cause a launch log names. The set is on the command, so a retry, a restart, or a fresh
  // build resolves nothing, and the connect loop has to stop on the attempt that reads the log — the
  // same terminal reading the service-hub cause gets.
  const destinationFailure = commandFailed('Runner did not accept connection', {
    reason: 'simulator_set_destination_not_found',
    runnerConnectFailureReason: 'runner_connect_refused',
    dispatched: 'no',
    simulatorSetPath: '/Users/dev/Library/Developer/CoreSimulator/Sets/foo.json',
  });
  assert.equal(shouldRetryRunnerConnectError(destinationFailure), false);
  assert.equal(isRetryableRunnerError(destinationFailure), false);
  assert.equal(shouldRestartRunnerBeforeCommandSend(destinationFailure, SNAPSHOT), false);
  assert.equal(shouldRebuildCachedRunnerArtifact(destinationFailure), false);
  assert.equal(
    shouldRestartRunnerAfterReadinessPreflight(
      commandFailed('Runner readiness refused', {
        reason: 'simulator_set_destination_not_found',
        runnerReadinessPreflightFailed: true,
      }),
    ),
    false,
  );
});

test('the reason in foreign text marks nothing terminal', () => {
  // The verdict keys on the reason the launch paths publish. A runner response or tool transcript that
  // merely repeats the words cannot order a failure non-retryable.
  const echoed = commandFailed(
    'Runner did not accept connection: simulator_set_destination_not_found',
    { stderr: 'DTServiceHubClient failed to bless service hub for simulator' },
  );
  assert.equal(shouldRetryRunnerConnectError(echoed), true);
});

test('a device that is busy connecting is a terminal connect verdict', () => {
  assert.equal(
    shouldRetryRunnerConnectError(commandFailed('Device is busy (Connecting to Simulator)')),
    false,
  );
});

// --- session-fatal axis (resolveRunnerFatalErrorReason) ---

test('session-fatal codes map to their invalidation reasons', () => {
  assert.equal(
    resolveRunnerFatalErrorReason(new AppError('IOS_AX_SNAPSHOT_FAILED', 'ax root failed')),
    'ax_snapshot_failure',
  );
  assert.equal(
    resolveRunnerFatalErrorReason(new AppError('XCTEST_RECORDED_FAILURE', 'recorded failure')),
    'xctest_recorded_failure',
  );
  assert.equal(
    resolveRunnerFatalErrorReason(new AppError('RUNNER_WEDGED', 'main thread stuck')),
    'runner_main_thread_wedged',
  );
});

test('ordinary errors are never session-fatal', () => {
  assert.equal(resolveRunnerFatalErrorReason(commandFailed('socket hang up')), undefined);
  assert.equal(resolveRunnerFatalErrorReason(new Error('boom')), undefined);
});

// --- restart-before-send axis (shouldRestartRunnerBeforeCommandSend) ---

test('a refused connection before send restarts the session', () => {
  assert.equal(shouldRestartRunnerBeforeCommandSend(unwrittenConnectRefusal(), TAP), true);
});

test('a connect failure whose POST may have been written restarts only a read', () => {
  // The POST left, then the request timed out.
  const writtenThenTimedOut = runnerConnectFailure('runner_connect_refused', undefined, {
    dispatched: 'unknown',
  });
  assert.equal(shouldRestartRunnerBeforeCommandSend(writtenThenTimedOut, TAP), false);
  assert.equal(shouldRestartRunnerBeforeCommandSend(writtenThenTimedOut, SNAPSHOT), true);
});

test('an early exit or a foreign transport failure earns no restart before send', () => {
  const earlyExit = runnerConnectFailure(
    'xcodebuild_exited_early',
    'xcodebuild exited early: runner did not accept connection',
  );
  assert.equal(shouldRestartRunnerBeforeCommandSend(earlyExit, SNAPSHOT), false);
  assert.equal(
    shouldRestartRunnerBeforeCommandSend(commandFailed('socket hang up'), SNAPSHOT),
    false,
  );
});

// --- typed connect-failure reasons (agent-device's own connect path) ---

test('xcodebuild_exited_early is decided by the typed reason, not the message', () => {
  for (const message of ['Runner did not accept connection (xcodebuild exited early)', 'boom']) {
    const error = runnerConnectFailure('xcodebuild_exited_early', message);
    assert.equal(isRetryableRunnerError(error), false, message);
    assert.equal(shouldRetryRunnerConnectError(error), false, message);
    assert.equal(shouldRebuildCachedRunnerArtifact(error), false, message);
    assert.equal(shouldRestartRunnerBeforeCommandSend(error, SNAPSHOT), false, message);
  }
  // The same words without the reason earn no terminal verdict.
  const untyped = commandFailed('Runner did not accept connection (xcodebuild exited early)');
  assert.equal(shouldRetryRunnerConnectError(untyped), true);
});

test('runner_connect_refused is decided by the typed reason, not the message', () => {
  for (const message of ['Runner did not accept connection', 'boom']) {
    const error = runnerConnectFailure('runner_connect_refused', message);
    assert.equal(isRetryableRunnerError(error), true, message);
    assert.equal(shouldRetryRunnerConnectError(error), true, message);
    assert.equal(shouldRebuildCachedRunnerArtifact(error), true, message);
    assert.equal(shouldRestartRunnerBeforeCommandSend(error, SNAPSHOT), true, message);
  }
  const untyped = commandFailed('Runner did not accept connection');
  assert.equal(isRetryableRunnerError(untyped), false);
  assert.equal(shouldRebuildCachedRunnerArtifact(untyped), false);
  assert.equal(shouldRestartRunnerBeforeCommandSend(untyped, SNAPSHOT), false);
});

test('runner_endpoint_probe_exhausted is decided by the typed reason, not the message', () => {
  for (const message of ['Runner endpoint probe failed', 'boom']) {
    const error = runnerConnectFailure('runner_endpoint_probe_exhausted', message);
    assert.equal(shouldRebuildCachedRunnerArtifact(error), true, message);
    assert.equal(isRetryableRunnerError(error), false, message);
    assert.equal(shouldRestartRunnerBeforeCommandSend(error, SNAPSHOT), false, message);
    assert.equal(shouldRetryRunnerConnectError(error), true, message);
  }
  assert.equal(
    shouldRebuildCachedRunnerArtifact(commandFailed('Runner endpoint probe failed')),
    false,
  );
});

// The literals are what the Swift runner encodes, so they are the contract and not the constant
// names: a rename on one side has to fail here rather than silently split the pair (#2728).
test('a refused screen capture keeps the runner reason and stays off the wire code', () => {
  assert.deepEqual([...RUNNER_SCREEN_CAPTURE_REFUSAL_RUNNER_CODES].sort(), [
    'APP_SCREEN_CAPTURE_UNRENDERABLE',
    'APP_SCREEN_OFF_LIT_PANEL',
    'APP_SCREEN_UNRESOLVED',
    'APP_SCREEN_WINDOW_UNRESOLVED',
  ]);
  for (const runnerCode of RUNNER_SCREEN_CAPTURE_REFUSAL_RUNNER_CODES) {
    const classified = classifyRunnerReportedError(runnerCode);
    assert.equal(classified.code, 'COMMAND_FAILED');
    assert.equal(classified.details.runnerErrorCode, runnerCode);
    assert.equal(classified.details.retriable, undefined);
  }
});

// --- busy refusal (isRunnerBusyError) ---

test('only the typed RUNNER_BUSY refusal reads as busy', () => {
  assert.equal(
    isRunnerBusyError(commandFailed('runner is busy', { runnerErrorCode: 'RUNNER_BUSY' })),
    true,
  );
  // The stalling command's own timeout already spent its wait: not a refusal to resend.
  assert.equal(
    isRunnerBusyError(
      commandFailed('main thread execution timed out', { runnerErrorCode: 'MAIN_THREAD_TIMEOUT' }),
    ),
    false,
  );
  assert.equal(
    isRunnerBusyError(
      commandFailed('The iOS runner is still finishing a previous command', { retriable: true }),
    ),
    false,
  );
  assert.equal(isRunnerBusyError(commandFailed('RUNNER_BUSY')), false);
  assert.equal(isRunnerBusyError(new Error('RUNNER_BUSY')), false);
});

// --- main-thread occupancy (runnerMainThreadOccupancyReport) ---

/** The AppError `buildRunnerResponseError` publishes for one runner wire code: its own details plus
 * the structured payload that makes the reply an answer. */
function runnerReplyFailure(runnerCode: string): AppError {
  const classified = classifyRunnerReportedError(runnerCode);
  return new AppError(classified.code, 'runner error', {
    ...classified.details,
    runner: { ok: false, error: { code: runnerCode, message: 'runner error' } },
  });
}

// Pins the daemon-side literal, in the repo's style for these codes. The cross-language tie — that the
// Swift runner really encodes this string — is the test below, which reads the Swift declaration.
test('the journal refusal of a finished commandId reports nothing about main-thread occupancy', () => {
  assert.equal(COMMAND_ALREADY_FINISHED_RUNNER_CODE, 'COMMAND_ALREADY_FINISHED');
  // The published shape, not only the runner detail: this code travels under its own name the way
  // `NO_TEXT_INPUT_AT_POINT` does, rather than staying `COMMAND_FAILED` like the diagnostic codes,
  // because no caller policy reads it — the runner will not re-run the command, whatever an earlier
  // send of that id did.
  const refusal = classifyRunnerReportedError(COMMAND_ALREADY_FINISHED_RUNNER_CODE);
  assert.equal(refusal.code, 'COMMAND_ALREADY_FINISHED');
  assert.equal(refusal.details.dispatched, 'unknown');
  assert.equal(refusal.details.retriable, undefined);
  const refusalError = new AppError(refusal.code, 'already finished', {
    ...refusal.details,
    runner: { ok: false, error: { code: COMMAND_ALREADY_FINISHED_RUNNER_CODE, message: 'x' } },
  });
  assert.equal(isRetryableRunnerError(refusalError), false);
  assert.equal(isRunnerBusyError(refusalError), false);
  assert.equal(runnerMainThreadOccupancyReport(refusalError), 'silent');
  // Without the structured runner payload there is no answer at all, which is also silent.
  assert.equal(runnerMainThreadOccupancyReport(commandFailed('boom')), 'silent');
});

test('occupancy reads the busy refusal and the stalling timeout as occupied, and a served failure as drained', () => {
  assert.equal(runnerMainThreadOccupancyReport(runnerReplyFailure('RUNNER_BUSY')), 'occupied');
  assert.equal(
    runnerMainThreadOccupancyReport(runnerReplyFailure('MAIN_THREAD_TIMEOUT')),
    'occupied',
  );
  assert.equal(runnerMainThreadOccupancyReport(runnerReplyFailure('ELEMENT_NOT_FOUND')), 'drained');
});

test('the runner declares the wire codes the daemon reads for occupancy', () => {
  const swift = requireSwiftThrownErrorWireCode();

  assert.equal(
    swift.timeoutCode,
    MAIN_THREAD_TIMEOUT_RUNNER_CODE,
    'the runner must encode the watchdog timeout under the code the daemon keys occupancy on',
  );
  assert.equal(
    swift.finishedCode,
    COMMAND_ALREADY_FINISHED_RUNNER_CODE,
    'the runner must encode its finished-id refusal under the code the daemon reads as silent',
  );
});

test('the runner declares the wire code the keyboard-dismiss refusal publishes its reason under', () => {
  assert.equal(
    requireSwiftKeyboardDismissRefusalWireCode(),
    KEYBOARD_DISMISS_UNAVAILABLE_RUNNER_CODE,
    'the runner must encode its no-dismiss-key refusal under the code the daemon maps to ' +
      'details.reason, or that reason becomes unreachable',
  );
});

test('the runner declares the wire codes the control refusals publish their reasons under', () => {
  const swift = requireSwiftControlRefusalWireCodes();
  assert.equal(
    swift.keyboardReturnCode,
    KEYBOARD_RETURN_UNAVAILABLE_RUNNER_CODE,
    'the runner must encode its nothing-to-submit refusal under the code the daemon maps to ' +
      'details.reason, or that reason becomes unreachable',
  );
  assert.equal(
    swift.hardwareControlCode,
    HARDWARE_CONTROL_UNAVAILABLE_RUNNER_CODE,
    'the runner must encode its cannot-press-here refusal under the code the daemon maps to ' +
      'details.reason, or that reason becomes unreachable',
  );
  assert.equal(
    swift.inAppBackControlCode,
    IN_APP_BACK_CONTROL_UNAVAILABLE_RUNNER_CODE,
    'the runner must encode its macOS no-back-control refusal under the code the daemon maps to ' +
      'details.reason, or that reason becomes unreachable',
  );
});

// --- runner that predates the listener token ---

test('a runner that does not require the token is session-fatal and never retried or replayed', () => {
  for (const extra of [{}, { runnerReadinessPreflightFailed: true }]) {
    const refusal = new AppError(
      'COMMAND_FAILED',
      'XCTest runner does not require a listener token',
      {
        reason: 'runner_token_unsupported',
        ...extra,
      },
    );
    assert.equal(resolveRunnerFatalErrorReason(refusal), 'runner_token_unsupported');
    assert.equal(isRetryableRunnerError(refusal), false);
    assert.equal(shouldRetryRunnerConnectError(refusal), false);
    assert.equal(shouldRestartRunnerBeforeCommandSend(refusal, SNAPSHOT), false);
    assert.equal(shouldRestartRunnerAfterReadinessPreflight(refusal), false);
    assert.equal(shouldRebuildCachedRunnerArtifact(refusal), false);
  }
});

test('forwarding recovery requires the typed gateway failure, never matching prose', () => {
  const message = 'Runner HTTP forwarding is unavailable';
  const typed = new AppError('COMMAND_FAILED', message, {
    reason: 'runner_forwarding_unavailable',
    status: 502,
  });
  assert.equal(isRetryableRunnerError(typed), true);
  assert.equal(shouldRestartRunnerBeforeCommandSend(typed, { command: 'tap' }), false);
  assert.equal(shouldRebuildCachedRunnerArtifact(typed), false);
  assert.equal(
    shouldRestartRunnerAfterReadinessPreflight(
      new AppError('COMMAND_FAILED', message, {
        ...typed.details,
        runnerReadinessPreflightFailed: true,
      }),
    ),
    false,
  );
  assert.equal(isRetryableRunnerError(new AppError('COMMAND_FAILED', message)), false);
});
