import assert from 'node:assert/strict';
import { beforeEach, test } from 'vitest';
import { createRequestCanceledError } from '@agent-device/kernel/errors';
import { appleRunnerTestHost } from '../test-host.ts';
import {
  callerDeadlineExpired,
  isCallerDeadlineAbortReason,
  resolveRunnerStartupSignal,
} from '../runner-contract.ts';

const registered = new Map<string, AbortController>();
const canceled = new Set<string>();

function deadlineReason(): DOMException {
  return new DOMException('Wait deadline exceeded', 'TimeoutError');
}

beforeEach(() => {
  registered.clear();
  canceled.clear();
  appleRunnerTestHost.update({
    getRequestSignal: (requestId) => (requestId ? registered.get(requestId)?.signal : undefined),
    isRequestCanceled: (requestId) => requestId !== undefined && canceled.has(requestId),
  });
});

test('a caller deadline is the typed TimeoutError reason, not its text', () => {
  assert.equal(isCallerDeadlineAbortReason(deadlineReason()), true);
  assert.equal(isCallerDeadlineAbortReason(new Error('Wait deadline exceeded')), false);
  assert.equal(isCallerDeadlineAbortReason(createRequestCanceledError()), false);
});

test('the startup signal ignores a caller deadline and forwards every other abort', () => {
  const deadline = new AbortController();
  const startup = resolveRunnerStartupSignal({ signal: deadline.signal });
  assert.ok(startup);
  deadline.abort(deadlineReason());
  assert.equal(startup.aborted, false);

  const disconnect = new AbortController();
  const killed = resolveRunnerStartupSignal({ signal: disconnect.signal });
  assert.ok(killed);
  const reason = new Error('client disconnected');
  disconnect.abort(reason);
  assert.equal(killed.aborted, true);
  assert.equal(killed.reason, reason);
});

test('a caller signal already aborted by its deadline does not abort the startup signal', () => {
  const expired = new AbortController();
  expired.abort(deadlineReason());
  const startup = resolveRunnerStartupSignal({ signal: expired.signal });
  assert.equal(startup?.aborted, false);
});

test('the registered request signal kills a start even when it rides with a caller deadline', () => {
  const request = new AbortController();
  registered.set('req-1', request);
  const deadline = new AbortController();
  const startup = resolveRunnerStartupSignal({ requestId: 'req-1', signal: deadline.signal });
  assert.ok(startup);
  deadline.abort(deadlineReason());
  assert.equal(startup.aborted, false);
  request.abort(createRequestCanceledError());
  assert.equal(startup.aborted, true);
});

test('without a caller signal the registered request signal is the startup signal itself', () => {
  const request = new AbortController();
  registered.set('req-2', request);
  assert.equal(resolveRunnerStartupSignal({ requestId: 'req-2' }), request.signal);
  assert.equal(resolveRunnerStartupSignal({}), undefined);
});

test('callerDeadlineExpired reads the deadline reason and yields to a cancelled request', () => {
  const deadline = new AbortController();
  deadline.abort(deadlineReason());
  assert.equal(callerDeadlineExpired({ signal: deadline.signal }), true);
  canceled.add('req-3');
  assert.equal(callerDeadlineExpired({ requestId: 'req-3', signal: deadline.signal }), false);
  const plain = new AbortController();
  plain.abort(new Error('client disconnected'));
  assert.equal(callerDeadlineExpired({ signal: plain.signal }), false);
  assert.equal(callerDeadlineExpired({}), false);
});
