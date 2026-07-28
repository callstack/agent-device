import { test } from 'vitest';
import assert from 'node:assert/strict';
import {
  AppError,
  asAppError,
  defaultHintForCode,
  isAgentDeviceError,
  KNOWN_APP_ERROR_CODES,
  normalizeAgentDeviceError,
  normalizeError,
  retriableForErrorCode,
  toAppErrorCode,
  type KnownAppErrorCode,
} from '../errors.ts';

test('normalizeError adds default hint and strips diagnostic metadata from details', () => {
  const err = new AppError('COMMAND_FAILED', 'runner failed', {
    token: 'secret',
    hint: 'custom hint',
    diagnosticId: 'diag-1',
    logPath: '/tmp/diag.log',
    safe: 'ok',
  });
  const normalized = normalizeError(err);
  assert.equal(normalized.code, 'COMMAND_FAILED');
  assert.equal(normalized.message, 'runner failed');
  assert.equal(normalized.hint, 'custom hint');
  assert.equal(normalized.diagnosticId, 'diag-1');
  assert.equal(normalized.logPath, '/tmp/diag.log');
  assert.equal(normalized.details?.token, '[REDACTED]');
  assert.equal(normalized.details?.safe, 'ok');
  assert.equal(Object.hasOwn(normalized.details ?? {}, 'hint'), false);
});

test('normalizeError enriches generic command-failed message with stderr excerpt', () => {
  const err = new AppError('COMMAND_FAILED', 'xcrun exited with code 1', {
    exitCode: 1,
    processExitError: true,
    stderr: '\nOperation not permitted\nUnderlying error details',
  });
  const normalized = normalizeError(err);
  assert.equal(normalized.message, 'Operation not permitted');
});

test('normalizeError appends stderr excerpt to specific command-failed messages', () => {
  const err = new AppError('COMMAND_FAILED', 'Android snapshot helper did not return XML', {
    exitCode: 1,
    processExitError: true,
    stderr: 'instrumentation unavailable\n',
  });
  const normalized = normalizeError(err);
  assert.equal(
    normalized.message,
    'Android snapshot helper did not return XML: instrumentation unavailable',
  );
});

test('normalizeError does not duplicate an excerpt already present in the message', () => {
  const err = new AppError('COMMAND_FAILED', 'simctl boot failed: device is locked', {
    exitCode: 1,
    processExitError: true,
    stderr: 'device is locked\n',
  });
  const normalized = normalizeError(err);
  assert.equal(normalized.message, 'simctl boot failed: device is locked');
});

test('normalizeError skips simctl boilerplate wrappers in stderr', () => {
  const err = new AppError('COMMAND_FAILED', 'xcrun exited with code 1', {
    exitCode: 1,
    processExitError: true,
    stderr: [
      'An error was encountered processing the command (domain=NSPOSIXErrorDomain, code=1):',
      'Simulator device failed to complete the requested operation.',
      'Operation not permitted',
      'Underlying error (domain=NSPOSIXErrorDomain, code=1):',
      '\tFailed to reset access',
      '\tOperation not permitted',
    ].join('\n'),
  });
  const normalized = normalizeError(err);
  assert.equal(normalized.message, 'Operation not permitted');
});

test('normalizeError strips adb and severity prefixes from the stderr excerpt', () => {
  const err = new AppError('COMMAND_FAILED', 'adb exited with code 1', {
    exitCode: 1,
    processExitError: true,
    stderr: 'adb: error: failed to get feature set: device offline\n',
  });
  const normalized = normalizeError(err);
  assert.equal(normalized.message, 'failed to get feature set: device offline');
});

test('normalizeError strips a bare error prefix when appending to a curated message', () => {
  const err = new AppError('COMMAND_FAILED', 'simctl boot failed', {
    exitCode: 1,
    processExitError: true,
    stderr: 'error: device is locked\n',
  });
  const normalized = normalizeError(err);
  assert.equal(normalized.message, 'simctl boot failed: device is locked');
});

test('normalizeError skips a stderr line that is only a noise prefix', () => {
  const err = new AppError('COMMAND_FAILED', 'xcrun exited with code 1', {
    exitCode: 1,
    processExitError: true,
    stderr: 'xcrun: error:\nunable to find utility simctl\n',
  });
  const normalized = normalizeError(err);
  assert.equal(normalized.message, 'unable to find utility simctl');
});

test('normalizeError provides app discovery guidance for app-not-installed errors', () => {
  const normalized = normalizeError(
    new AppError('APP_NOT_INSTALLED', 'No package found matching "chat"'),
  );
  assert.match(
    normalized.hint ?? '',
    /Run apps to discover the exact installed package or bundle id/i,
  );
});

test('normalizeError lifts details.retriable to the top level and strips it from details', () => {
  const normalized = normalizeError(
    new AppError('COMMAND_FAILED', 'adb exited with code 1', {
      stderr: 'error: device offline',
      retriable: true,
    }),
  );
  assert.equal(normalized.retriable, true);
  assert.equal(Object.hasOwn(normalized.details ?? {}, 'retriable'), false);
});

test('normalizeError omits retriable when the throw site did not classify it', () => {
  const normalized = normalizeError(new AppError('COMMAND_FAILED', 'adb exited with code 1'));
  assert.equal(Object.hasOwn(normalized, 'retriable'), false);
});

test('toAppErrorCode falls back when code is missing or empty', () => {
  assert.equal(toAppErrorCode(undefined), 'COMMAND_FAILED');
  assert.equal(toAppErrorCode(''), 'COMMAND_FAILED');
  assert.equal(toAppErrorCode(undefined, 'UNAUTHORIZED'), 'UNAUTHORIZED');
});

// --- ADR 0012 migration step 2: divergence survives daemon -> client -> CLI/MCP ---

test('normalizeError preserves details.divergence verbatim through redaction/stripDiagnosticMeta', () => {
  const divergence = {
    version: 1 as const,
    kind: 'action-failure' as const,
    step: { index: 2, source: { path: '/tmp/flow.ad', line: 5 } },
    action: 'click "Save"',
    cause: { code: 'COMMAND_FAILED', message: 'not hittable' },
    screen: {
      state: 'available' as const,
      refsGeneration: 3,
      refs: [{ ref: 'e5', role: 'button', label: 'Save' }],
    },
    suggestions: [],
    suggestionCount: 0,
    resume: { allowed: false as const, reason: 'resume not yet supported' },
  };
  const err = new AppError('REPLAY_DIVERGENCE', 'Replay failed at step 2', {
    step: 2,
    action: 'click',
    divergence,
  });
  const normalized = normalizeError(err);
  assert.equal(normalized.code, 'REPLAY_DIVERGENCE');
  // stripDiagnosticMeta only removes hint/diagnosticId/logPath/retriable/supportedOn.
  assert.deepEqual(normalized.details?.divergence, divergence);
  assert.equal(normalized.details?.step, 2);
});

test('daemon-originated REPLAY_DIVERGENCE gets a default hint pointing at the report', () => {
  const normalized = normalizeError(
    new AppError('REPLAY_DIVERGENCE', 'Replay failed at step 1', {}),
  );
  assert.match(normalized.hint ?? '', /details\.divergence/);
});

// --- maybeEnrichCommandFailedMessage: gating conditions, isolated from the
// stderr-parsing cases above ---

test('normalizeError does not enrich the message for a non-COMMAND_FAILED code, even with processExitError/stderr present', () => {
  const err = new AppError('DEVICE_NOT_FOUND', 'device vanished', {
    processExitError: true,
    stderr: 'some completely different stderr text',
  });
  const normalized = normalizeError(err);
  assert.equal(normalized.message, 'device vanished');
});

test('normalizeError does not enrich a COMMAND_FAILED message when processExitError is absent', () => {
  const err = new AppError('COMMAND_FAILED', 'xcrun exited with code 1', {
    stderr: 'Operation not permitted',
  });
  const normalized = normalizeError(err);
  assert.equal(normalized.message, 'xcrun exited with code 1');
});

test('normalizeError does not enrich a COMMAND_FAILED message when processExitError is exactly false', () => {
  const err = new AppError('COMMAND_FAILED', 'xcrun exited with code 1', {
    processExitError: false,
    stderr: 'Operation not permitted',
  });
  const normalized = normalizeError(err);
  assert.equal(normalized.message, 'xcrun exited with code 1');
});

test('normalizeError ignores a non-string details.stderr value rather than enriching the message with it', () => {
  const err = new AppError('COMMAND_FAILED', 'xcrun exited with code 1', {
    processExitError: true,
    stderr: 12345 as unknown as string,
  });
  const normalized = normalizeError(err);
  assert.equal(normalized.message, 'xcrun exited with code 1');
});

test('normalizeError leaves the message unchanged when stderr yields no usable excerpt', () => {
  const err = new AppError('COMMAND_FAILED', 'simctl boot failed', {
    processExitError: true,
    // Every line is blank or matches a skip pattern, so firstStderrLine finds nothing.
    stderr: '\n  \nAn error was encountered processing the command (domain=X, code=1):\n',
  });
  const normalized = normalizeError(err);
  assert.equal(normalized.message, 'simctl boot failed');
});

// GENERIC_EXIT_MESSAGE boundary: pins `^\S+ exited with code -?\d+$` exactly —
// a single tool token, an optional leading minus, and nothing after the digits.

test('normalizeError replaces (rather than appends) for a generic exit message with a negative exit code', () => {
  const err = new AppError('COMMAND_FAILED', 'xcrun exited with code -1', {
    processExitError: true,
    stderr: 'Operation not permitted',
  });
  const normalized = normalizeError(err);
  assert.equal(normalized.message, 'Operation not permitted');
});

test('normalizeError appends (rather than replaces) when trailing text follows the exit code', () => {
  const err = new AppError('COMMAND_FAILED', 'xcrun exited with code 1 (signal 0)', {
    processExitError: true,
    stderr: 'Operation not permitted',
  });
  const normalized = normalizeError(err);
  assert.equal(normalized.message, 'xcrun exited with code 1 (signal 0): Operation not permitted');
});

test('normalizeError appends (rather than replaces) when the exit code is non-numeric', () => {
  const err = new AppError('COMMAND_FAILED', 'xcrun exited with code abc', {
    processExitError: true,
    stderr: 'Operation not permitted',
  });
  const normalized = normalizeError(err);
  assert.equal(normalized.message, 'xcrun exited with code abc: Operation not permitted');
});

test('normalizeError appends (rather than replaces) when the tool token itself contains whitespace', () => {
  const err = new AppError('COMMAND_FAILED', 'my tool exited with code 1', {
    processExitError: true,
    stderr: 'Operation not permitted',
  });
  const normalized = normalizeError(err);
  assert.equal(normalized.message, 'my tool exited with code 1: Operation not permitted');
});

// STDERR_NOISE_PREFIX boundary: the adb/xcrun/simctl and "error:" groups each
// consume only whitespace (`\s*`), never greedily eating adjacent non-whitespace
// content, and each group is independently optional.

test('normalizeError strips only the adb/xcrun/simctl token, not adjacent non-whitespace content that follows it directly', () => {
  const err = new AppError('COMMAND_FAILED', 'adb exited with code 1', {
    processExitError: true,
    stderr: 'adb:deviceOffline still not ready\n',
  });
  const normalized = normalizeError(err);
  assert.equal(normalized.message, 'deviceOffline still not ready');
});

test('normalizeError strips a zero-space "error:" prefix without requiring or over-consuming whitespace', () => {
  const err = new AppError('COMMAND_FAILED', 'simctl boot failed', {
    processExitError: true,
    stderr: 'error:immediate text\n',
  });
  const normalized = normalizeError(err);
  assert.equal(normalized.message, 'simctl boot failed: immediate text');
});

test('normalizeError trims each stderr line before prefix-matching, so leading whitespace cannot defeat the anchored noise-prefix regex', () => {
  // The leading-whitespace line must NOT be the string's first/last line: the
  // whole `details.stderr` value is `.trim()`-ed once by redaction before
  // firstStderrLine ever sees it, which would otherwise erase exactly the
  // whitespace this test needs to keep. A real skip-pattern line ahead of it
  // keeps that whitespace internal to the string.
  const err = new AppError('COMMAND_FAILED', 'simctl boot failed', {
    processExitError: true,
    stderr:
      'An error was encountered processing the command (domain=X):\n' +
      '  error: leading whitespace line\n',
  });
  const normalized = normalizeError(err);
  assert.equal(normalized.message, 'simctl boot failed: leading whitespace line');
});

// firstStderrLine truncates an excerpt over 200 characters; pin both sides of
// that boundary explicitly since a passing-but-short-excerpt test can never
// exercise it.

test('normalizeError truncates a stderr excerpt over 200 characters and appends an ellipsis', () => {
  const longLine = 'x'.repeat(250);
  const err = new AppError('COMMAND_FAILED', 'simctl boot failed', {
    processExitError: true,
    stderr: `${longLine}\n`,
  });
  const normalized = normalizeError(err);
  assert.equal(normalized.message, `simctl boot failed: ${'x'.repeat(200)}...`);
});

test('normalizeError leaves a stderr excerpt of exactly 200 characters untruncated', () => {
  const exactLine = 'y'.repeat(200);
  const err = new AppError('COMMAND_FAILED', 'simctl boot failed', {
    processExitError: true,
    stderr: `${exactLine}\n`,
  });
  const normalized = normalizeError(err);
  assert.equal(normalized.message, `simctl boot failed: ${exactLine}`);
});

// --- stringDetail/booleanDetail/stripDiagnosticMeta: type-guard and
// empty-after-stripping contracts normalizeError relies on ---

test('normalizeError ignores a non-string details.diagnosticId/logPath/hint rather than surfacing the wrong-typed value', () => {
  const normalized = normalizeError(
    new AppError('COMMAND_FAILED', 'runner failed', {
      diagnosticId: 12345 as unknown as string,
      logPath: true as unknown as string,
      hint: [] as unknown as string,
    }),
  );
  assert.equal(normalized.diagnosticId, undefined);
  assert.equal(normalized.logPath, undefined);
  // hint falls back to the code's default once the non-string value is rejected.
  assert.equal(normalized.hint, defaultHintForCode('COMMAND_FAILED'));
});

test('normalizeError ignores a non-boolean details.retriable and falls back to the code-level default', () => {
  const normalized = normalizeError(
    new AppError('DEVICE_IN_USE', 'device busy', { retriable: 'yes' as unknown as boolean }),
  );
  assert.equal(normalized.retriable, true); // retriableForErrorCode('DEVICE_IN_USE') default, not the string.
});

test('normalizeError omits details entirely once stripping diagnostic-meta keys leaves nothing behind', () => {
  const normalized = normalizeError(
    new AppError('COMMAND_FAILED', 'runner failed', {
      hint: 'custom hint',
      diagnosticId: 'diag-1',
      logPath: '/tmp/diag.log',
      retriable: true,
      supportedOn: 'ios',
    }),
  );
  assert.equal(normalized.details, undefined);
});

// --- AppError: construction contract ---

test('AppError is a real Error carrying code/message/details/cause', () => {
  const cause = new Error('root cause');
  const err = new AppError('DEVICE_NOT_FOUND', 'no device', { hint: 'custom' }, cause);
  assert.ok(err instanceof Error);
  assert.ok(err instanceof AppError);
  assert.equal(err.name, 'Error'); // AppError does not override `name`.
  assert.equal(err.code, 'DEVICE_NOT_FOUND');
  assert.equal(err.message, 'no device');
  assert.deepEqual(err.details, { hint: 'custom' });
  assert.equal(err.cause, cause);
});

test('AppError leaves details and cause undefined when the constructor omits them', () => {
  const err = new AppError('UNKNOWN', 'plain');
  assert.equal(err.details, undefined);
  assert.equal(err.cause, undefined);
});

// --- asAppError: identity, wrapping, and duck-typing contract ---
//
// Every catch site that normalizes a thrown value (src/cli.ts, src/daemon.ts,
// src/daemon/server/daemon-runtime.ts, the platform runners) funnels through
// `asAppError`, so its branch selection is load-bearing: get it wrong and a
// caller silently loses a real error's message/stack.

test('asAppError returns an AppError input unchanged — no re-wrap, same instance', () => {
  const original = new AppError('TOOL_MISSING', 'missing tool');
  assert.equal(asAppError(original), original);
});

test('asAppError wraps a plain Error under the fallback code, preserving its message and chaining it as cause', () => {
  const original = new Error('boom');
  const wrapped = asAppError(original);
  assert.ok(wrapped instanceof AppError);
  assert.notEqual(wrapped, original);
  assert.equal(wrapped.code, 'UNKNOWN');
  assert.equal(wrapped.message, 'boom');
  assert.equal(wrapped.details, undefined);
  assert.equal(wrapped.cause, original);
});

test('asAppError honors an explicit fallback code when wrapping a plain Error', () => {
  const wrapped = asAppError(new Error('boom'), 'COMMAND_FAILED');
  assert.equal(wrapped.code, 'COMMAND_FAILED');
  assert.equal(wrapped.message, 'boom');
});

test('asAppError wraps a non-Error throw as "Unknown error" and preserves the raw value in details.err', () => {
  const wrapped = asAppError('a raw string throw');
  assert.equal(wrapped.code, 'UNKNOWN');
  assert.equal(wrapped.message, 'Unknown error');
  assert.equal(wrapped.details?.err, 'a raw string throw');
  assert.equal(wrapped.cause, undefined);
});

test('asAppError applies the fallback code to non-Error throws too, not just Error instances', () => {
  const wrapped = asAppError({ some: 'object' }, 'INVALID_ARGS');
  assert.equal(wrapped.code, 'INVALID_ARGS');
  assert.equal(wrapped.message, 'Unknown error');
  assert.deepEqual(wrapped.details?.err, { some: 'object' });
});

test('asAppError wraps null/undefined the same as any other non-Error value, keeping the raw value in details.err', () => {
  const wrappedNull = asAppError(null);
  assert.equal(wrappedNull.code, 'UNKNOWN');
  assert.equal(wrappedNull.message, 'Unknown error');
  assert.equal(wrappedNull.details?.err, null);
  assert.ok(Object.hasOwn(wrappedNull.details ?? {}, 'err'));

  const wrappedUndefined = asAppError(undefined);
  assert.equal(wrappedUndefined.message, 'Unknown error');
  assert.ok(Object.hasOwn(wrappedUndefined.details ?? {}, 'err'));
  assert.equal(wrappedUndefined.details?.err, undefined);
});

test('asAppError does not special-case a duck-typed, cross-realm-style Error lookalike — it falls through the non-Error branch', () => {
  // `instanceof Error` fails for a cross-realm Error (different VM context) and
  // for any plain object shaped like one. `asAppError` has no fallback for that
  // case: it treats the value as an opaque non-Error and drops its message and
  // stack into details.err instead of preserving them as `.message`/`.cause`.
  // Every catch-site caller relies on exactly this fallthrough, not a smarter
  // duck-typed detection, so pin it as the contract rather than an accident.
  const duckTypedError = { name: 'Error', message: 'looks like an error', stack: 'fake stack' };
  const wrapped = asAppError(duckTypedError);
  assert.equal(wrapped.code, 'UNKNOWN');
  assert.equal(wrapped.message, 'Unknown error');
  assert.equal(wrapped.details?.err, duckTypedError);
  assert.notEqual(wrapped.message, duckTypedError.message);
});

// --- isAgentDeviceError: real instances only, no duck-typing ---

test('isAgentDeviceError is true only for a real AppError instance', () => {
  assert.equal(isAgentDeviceError(new AppError('UNKNOWN', 'x')), true);
});

test('isAgentDeviceError is false for a plain Error', () => {
  assert.equal(isAgentDeviceError(new Error('plain error')), false);
});

test('isAgentDeviceError is false for an object that merely duck-types the AppError shape', () => {
  const lookalike = { code: 'UNKNOWN', message: 'x', name: 'AppError', details: undefined };
  assert.equal(isAgentDeviceError(lookalike), false);
});

test('isAgentDeviceError is false for nullish and primitive values', () => {
  assert.equal(isAgentDeviceError(null), false);
  assert.equal(isAgentDeviceError(undefined), false);
  assert.equal(isAgentDeviceError('not an error'), false);
  assert.equal(isAgentDeviceError(42), false);
});

// --- retriableForErrorCode: table-driven over the module's own code registry ---
//
// The enumeration comes from `KNOWN_APP_ERROR_CODES` itself (the module's
// documented source of truth for "every code that must resolve a verdict"),
// never a hand-copied subset — a code added to the registry without a matching
// verdict decision automatically gets a test case here.

/** The only code with a confident retriability verdict today (see RETRIABILITY_BY_CODE in errors.ts). */
const RETRIABLE_TRUE_CODES: readonly KnownAppErrorCode[] = ['DEVICE_IN_USE'];

for (const code of KNOWN_APP_ERROR_CODES) {
  const expected = RETRIABLE_TRUE_CODES.includes(code) ? true : undefined;
  test(`retriableForErrorCode('${code}') is ${expected}`, () => {
    assert.equal(retriableForErrorCode(code), expected);
  });
}

test('retriableForErrorCode returns undefined for a daemon/runner-originated code outside the known registry', () => {
  assert.equal(retriableForErrorCode('SOME_DAEMON_ONLY_CODE'), undefined);
  assert.equal(retriableForErrorCode(''), undefined);
});

// --- defaultHintForCode: table-driven over the module's own code registry ---

/** Mirrors the switch in `defaultHintForCode` — one entry per `KNOWN_APP_ERROR_CODES` member. */
const EXPECTED_HINT_BY_CODE: Record<KnownAppErrorCode, string> = {
  INVALID_ARGS: 'Check command arguments and run --help for usage examples.',
  DEVICE_NOT_FOUND: 'Verify the target device is booted/connected and selectors match.',
  DEVICE_IN_USE: 'The device is busy with another agent-device request; retry once it frees up.',
  TOOL_MISSING: 'Install required platform tooling and ensure it is available in PATH.',
  APP_NOT_INSTALLED:
    'Run apps to discover the exact installed package or bundle id, or install the app before open.',
  UNSUPPORTED_PLATFORM:
    'This platform is not supported for the requested operation; run devices to inspect available targets.',
  UNSUPPORTED_OPERATION: 'This command is not available for the selected platform/device.',
  NOT_IMPLEMENTED: 'This command is part of the planned API but is not implemented yet.',
  COMMAND_FAILED: 'Retry with --debug and inspect diagnostics log for details.',
  SESSION_NOT_FOUND: 'Run open first or pass an explicit device selector.',
  UNAUTHORIZED: 'Refresh daemon metadata and retry the command.',
  AMBIGUOUS_MATCH: 'Multiple candidates matched. Narrow the query or pass an exact identifier.',
  REPLAY_DIVERGENCE:
    'Read details.divergence (screen/suggestions) for repair context, or rerun with --json for the full report.',
  REPAIR_SESSION_EXPIRED:
    'The --save-script repair session was reaped before it was finalized; re-run replay <script> --save-script from the start.',
  REPAIR_COMMIT_FAILED:
    'The repair transaction completed, but committing its healed script failed at teardown (no-clobber refusal or a filesystem error); inspect the target path/permissions, then re-run replay <script> --save-script to retry.',
  UNKNOWN:
    'Unexpected internal error. Retry with --debug and report the diagnostics log if it persists.',
};

for (const code of KNOWN_APP_ERROR_CODES) {
  test(`defaultHintForCode('${code}') matches the documented hint`, () => {
    assert.equal(defaultHintForCode(code), EXPECTED_HINT_BY_CODE[code]);
  });
}

test('EXPECTED_HINT_BY_CODE covers every known code — a registry addition without a hint decision fails loudly', () => {
  assert.deepEqual(Object.keys(EXPECTED_HINT_BY_CODE).sort(), [...KNOWN_APP_ERROR_CODES].sort());
});

test('defaultHintForCode falls back to the generic retry hint for a daemon/runner-originated code outside the registry', () => {
  assert.equal(
    defaultHintForCode('SOME_DAEMON_ONLY_CODE'),
    'Retry with --debug and inspect diagnostics log for details.',
  );
});

test('defaultHintForCode never returns a falsy hint for any known code — printHumanError silently drops a falsy hint', () => {
  // src/utils/output.ts's printHumanError only prints "Hint: ..." when
  // `normalized.hint` is truthy, so an empty-string hint would silently vanish
  // from CLI output rather than fail loudly.
  for (const code of KNOWN_APP_ERROR_CODES) {
    const hint = defaultHintForCode(code);
    assert.ok(hint, `expected a non-empty hint for ${code}`);
  }
});

// --- Cross-cutting contract: normalizeError composes retriableForErrorCode and
// defaultHintForCode exactly the way src/daemon/request-router.ts's
// enrichDaemonError (`error.retriable ?? retriableForErrorCode(error.code)`)
// and the CLI's printHumanError expect, for every registered code. ---

test('normalizeError resolves the default hint and retriability for every known code when the throw site supplies neither', () => {
  for (const code of KNOWN_APP_ERROR_CODES) {
    const normalized = normalizeError(new AppError(code, `failure for ${code}`));
    assert.equal(normalized.hint, defaultHintForCode(code), code);
    assert.equal(normalized.retriable, retriableForErrorCode(code), code);
    assert.equal(
      Object.hasOwn(normalized, 'retriable'),
      retriableForErrorCode(code) !== undefined,
      code,
    );
  }
});

test('normalizeError lets an explicit details.retriable override the code-level default, even overriding DEVICE_IN_USE to false', () => {
  const normalized = normalizeError(
    new AppError('DEVICE_IN_USE', 'device busy', { retriable: false }),
  );
  assert.equal(normalized.retriable, false);
});

// --- normalizeAgentDeviceError: the SDK-facing name for normalizeError ---
// (src/sdk/index.ts re-exports it under this name for public consumers.)

test('normalizeAgentDeviceError delegates to normalizeError, including the context argument', () => {
  const err = new AppError('SESSION_NOT_FOUND', 'gone');
  const normalized = normalizeAgentDeviceError(err, {
    diagnosticId: 'diag-9',
    logPath: '/tmp/9.log',
  });
  assert.deepEqual(
    normalized,
    normalizeError(err, { diagnosticId: 'diag-9', logPath: '/tmp/9.log' }),
  );
  assert.equal(normalized.diagnosticId, 'diag-9');
  assert.equal(normalized.logPath, '/tmp/9.log');
});
