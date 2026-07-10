import { test } from 'vitest';
import assert from 'node:assert/strict';
import { throwDaemonError } from '../daemon-error.ts';
import { AppError, normalizeError } from '../kernel/errors.ts';
import type { DaemonError } from '../kernel/contracts.ts';

// ADR 0012 migration step 2: "the Node client rejects with AppError retaining
// details.divergence" — this is the single conversion point (every
// client-facing command function funnels a failed DaemonResponse through
// throwDaemonError), so this contract test is the daemon -> Node client leg
// of the four-surface preservation chain (daemon -> client -> CLI -> MCP).
test('throwDaemonError preserves details.divergence into the thrown AppError', () => {
  const divergence = {
    version: 1 as const,
    kind: 'action-failure' as const,
    step: { index: 3, source: { path: '/tmp/flow.ad', line: 9 } },
    action: 'click "Save"',
    cause: { code: 'COMMAND_FAILED', message: 'not hittable' },
    screen: { state: 'unavailable' as const, reason: 'capture-failed' },
    suggestions: [],
    suggestionCount: 0,
    resume: { allowed: false as const, reason: 'resume not yet supported' },
  };
  const daemonError: DaemonError = {
    code: 'REPLAY_DIVERGENCE',
    message: 'Replay failed at step 3',
    hint: 'Read details.divergence',
    details: { step: 3, action: 'click', divergence },
  };

  let caught: unknown;
  try {
    throwDaemonError(daemonError);
  } catch (error) {
    caught = error;
  }

  assert.ok(caught instanceof AppError);
  const appErr = caught as AppError;
  assert.equal(appErr.code, 'REPLAY_DIVERGENCE');
  assert.deepEqual(appErr.details?.divergence, divergence);

  // The full chain: daemon -> throwDaemonError -> AppError -> normalizeError
  // (the CLI/MCP boundary) still carries it, JSON-round-trippable for --json.
  const normalized = normalizeError(appErr);
  assert.deepEqual(normalized.details?.divergence, divergence);
  const roundTripped = JSON.parse(JSON.stringify({ success: false, error: normalized })) as {
    error: { details?: { divergence?: unknown } };
  };
  assert.deepEqual(roundTripped.error.details?.divergence, divergence);
});
