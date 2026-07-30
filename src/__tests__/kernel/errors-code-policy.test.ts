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
} from '@agent-device/kernel/errors';

test('toAppErrorCode falls back when code is missing or empty', () => {
  assert.equal(toAppErrorCode(undefined), 'COMMAND_FAILED');
  assert.equal(toAppErrorCode(''), 'COMMAND_FAILED');
  assert.equal(toAppErrorCode(undefined, 'UNAUTHORIZED'), 'UNAUTHORIZED');
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
