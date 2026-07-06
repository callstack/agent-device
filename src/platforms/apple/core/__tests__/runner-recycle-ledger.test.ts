import { beforeEach, test } from 'vitest';
import assert from 'node:assert/strict';
import { AppError } from '../../../../kernel/errors.ts';
import {
  buildRunnerRecycleBudgetExhaustedError,
  commitRunnerRecycle,
  hasRunnerRequestTouchedSession,
  markRunnerRequestTouchedSession,
  resetRunnerRecycleLedgerForTests,
  runnerRecycleLedgerKey,
  tryBeginRunnerRecycle,
} from '../runner/runner-recycle-ledger.ts';

beforeEach(() => {
  resetRunnerRecycleLedgerForTests();
});

test('ledger key prefers the request id and falls back to the command id', () => {
  assert.equal(
    runnerRecycleLedgerKey({ requestId: 'req-1' }, { commandId: 'cmd-1' }),
    'request:req-1',
  );
  assert.equal(runnerRecycleLedgerKey({}, { commandId: 'cmd-1' }), 'command:cmd-1');
  assert.equal(runnerRecycleLedgerKey({ requestId: '  ' }, { commandId: ' ' }), undefined);
});

test('a request gets exactly one successful runner recycle, then must fail fast', () => {
  const key = 'request:req-wedge';
  assert.equal(tryBeginRunnerRecycle(key), true);
  commitRunnerRecycle(key);
  assert.equal(tryBeginRunnerRecycle(key), false);
  assert.equal(tryBeginRunnerRecycle(key), false);
  // Other requests keep their own budget.
  assert.equal(tryBeginRunnerRecycle('request:req-other'), true);
});

test('failed replacement boots do not consume the recycle budget', () => {
  const key = 'request:req-transient-boot-failure';
  assert.equal(tryBeginRunnerRecycle(key), true);
  assert.equal(tryBeginRunnerRecycle(key), true);
  commitRunnerRecycle(key);
  assert.equal(tryBeginRunnerRecycle(key), false);
});

test('untracked keys never block (no scope to account against)', () => {
  assert.equal(tryBeginRunnerRecycle(undefined), true);
  assert.equal(tryBeginRunnerRecycle(undefined), true);
  commitRunnerRecycle(undefined); // no-op, must not throw
  assert.equal(hasRunnerRequestTouchedSession(undefined), false);
  markRunnerRequestTouchedSession(undefined); // no-op, must not throw
});

test('touched-session marker distinguishes a first boot from a recycle boot', () => {
  const key = 'request:req-cold';
  assert.equal(hasRunnerRequestTouchedSession(key), false);
  markRunnerRequestTouchedSession(key);
  assert.equal(hasRunnerRequestTouchedSession(key), true);
});

test('exhausted-budget error is actionable and preserves the session contract', () => {
  const error = buildRunnerRecycleBudgetExhaustedError(
    { command: 'snapshot', commandId: 'cmd-9' },
    { requestId: 'req-9', logPath: '/tmp/runner.log' },
  );
  assert.ok(error instanceof AppError);
  assert.equal(error.code, 'COMMAND_FAILED');
  assert.match(error.message, /already restarted/);
  assert.equal(error.details?.recovery, 'runner_recycle_budget_exhausted');
  assert.match(String(error.details?.hint), /session is preserved/);
  assert.match(String(error.details?.hint), /screenshot/);
});
