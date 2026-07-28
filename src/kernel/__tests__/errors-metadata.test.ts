import { test } from 'vitest';
import assert from 'node:assert/strict';
import {
  AppError,
  defaultHintForCode,
  KNOWN_APP_ERROR_CODES,
  normalizeError,
  retriableForErrorCode,
} from '../errors.ts';

// hint/diagnosticId/logPath/retriable/supportedOn: what normalizeError lifts
// out of details onto the wire shape, and what it strips back out.

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

// --- Cross-cutting contract: normalizeError composes retriableForErrorCode and
// defaultHintForCode exactly the way src/daemon/request-router.ts's
// enrichDaemonError (`error.retriable ?? retriableForErrorCode(error.code)`)
// and the CLI's printHumanError expect, for every registered code. Per-code
// hint/retriability policy itself is pinned in errors-code-policy.test.ts. ---

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
