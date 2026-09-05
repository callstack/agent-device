import assert from 'node:assert/strict';
import { test } from 'vitest';
import { resolveDaemonRequestTimeoutMs } from '../request-timeout.ts';

test('wait request timeout extends past the user-supplied wait budget', () => {
  const base = {
    session: 'default',
    positionals: [] as string[],
    flags: {},
    meta: {},
  };

  // Explicit budgets beyond the default envelope extend it (budget + margin).
  assert.equal(
    resolveDaemonRequestTimeoutMs({
      ...base,
      command: 'wait',
      positionals: ['text', 'Ready', '180000'],
    }),
    210_000,
  );
  assert.equal(
    resolveDaemonRequestTimeoutMs({
      ...base,
      command: 'wait',
      positionals: ['stable', '500', '120000'],
    }),
    150_000,
  );
  // Sleep waits block for their full duration and get the same treatment.
  assert.equal(
    resolveDaemonRequestTimeoutMs({ ...base, command: 'wait', positionals: ['120000'] }),
    150_000,
  );
  // Small budgets never shrink the envelope below the default.
  assert.equal(
    resolveDaemonRequestTimeoutMs({
      ...base,
      command: 'wait',
      positionals: ['text', 'Ready', '5000'],
    }),
    90_000,
  );
  // No explicit budget → default envelope.
  assert.equal(
    resolveDaemonRequestTimeoutMs({ ...base, command: 'wait', positionals: ['text', 'Ready'] }),
    90_000,
  );
  assert.equal(resolveDaemonRequestTimeoutMs({ ...base, command: 'wait' }), 90_000);
});

test('interaction --settle budgets add post-action settle time on top of the normal envelope', () => {
  const base = {
    session: 'default',
    positionals: ['@e2'],
    meta: {},
  };

  // --timeout bounds the SETTLE wait after selector resolution and the action,
  // so the envelope keeps the normal touch-command overhead and then adds the
  // settle budget plus the same safety margin used by wait.
  assert.equal(
    resolveDaemonRequestTimeoutMs({
      ...base,
      command: 'press',
      flags: { settle: true, timeoutMs: 120_000 },
    }),
    240_000,
  );
  // A small settle deadline still needs the normal touch-command envelope plus
  // room for post-action observation.
  assert.equal(
    resolveDaemonRequestTimeoutMs({
      ...base,
      command: 'fill',
      flags: { settle: true, timeoutMs: 5_000 },
    }),
    125_000,
  );
  // Longpress keeps the cold Android helper route and its 120-second maximum
  // hold inside the outer envelope.
  assert.equal(
    resolveDaemonRequestTimeoutMs({
      ...base,
      command: 'longpress',
      positionals: ['300', '500', '120000'],
      flags: {},
    }),
    210_000,
  );
  // Bare --settle adds its default budget after the longpress-specific base,
  // so a maximum hold still leaves room for post-action observation.
  assert.equal(
    resolveDaemonRequestTimeoutMs({
      ...base,
      command: 'longpress',
      flags: { settle: true },
    }),
    250_000,
  );
  // Bare timeoutMs without --settle remains wire-compatible with older touch
  // command clients: it is ignored instead of opting into settle semantics.
  assert.equal(
    resolveDaemonRequestTimeoutMs({
      ...base,
      command: 'press',
      flags: { timeoutMs: 120_000 },
    }),
    90_000,
  );
  assert.equal(resolveDaemonRequestTimeoutMs({ ...base, command: 'press', flags: {} }), 90_000);
});

test('snapshot uses the standard daemon request timeout with an explicit override', () => {
  const base = {
    session: 'default',
    positionals: [],
    flags: {},
    meta: {},
  };

  assert.equal(resolveDaemonRequestTimeoutMs({ ...base, command: 'snapshot' }), 90_000);
  assert.equal(
    resolveDaemonRequestTimeoutMs({
      ...base,
      command: 'snapshot',
      flags: { timeoutMs: 120_000 },
    }),
    120_000,
  );
  assert.equal(resolveDaemonRequestTimeoutMs({ ...base, command: 'screenshot' }), 90_000);
  assert.equal(resolveDaemonRequestTimeoutMs({ ...base, command: 'install' }), 180_000);
  assert.equal(resolveDaemonRequestTimeoutMs({ ...base, command: 'reinstall' }), 180_000);
  assert.equal(resolveDaemonRequestTimeoutMs({ ...base, command: 'install_source' }), 180_000);
  assert.equal(
    resolveDaemonRequestTimeoutMs({
      ...base,
      command: 'prepare',
      positionals: ['ios-runner'],
    }),
    240_000,
  );
  assert.equal(
    resolveDaemonRequestTimeoutMs({
      ...base,
      command: 'prepare',
      positionals: ['ios-runner'],
      flags: { timeoutMs: 240_000 },
    }),
    240_000,
  );
  assert.equal(resolveDaemonRequestTimeoutMs({ ...base, command: 'test' }), undefined);
});
