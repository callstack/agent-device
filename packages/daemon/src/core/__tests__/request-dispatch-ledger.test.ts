import assert from 'node:assert/strict';
import { test } from 'vitest';
import { AppError } from '@agent-device/kernel/errors';
import type { DaemonRequest, DaemonResponse } from '../daemon-request.ts';
import {
  createRequestDispatchLedger,
  recordBoundMutations,
  recordNestedRequests,
  requestDispatchLedger,
} from '../request-dispatch-ledger.ts';

const REQUEST: DaemonRequest = { token: 't', session: 's', command: 'press', positionals: [] };

test('a bound mutation records its send once it returns; a read and a failed send do not', async () => {
  const ledger = createRequestDispatchLedger();
  const bound = recordBoundMutations(
    {
      operations: {
        tapPoint: async () => ({}),
        typeText: async () => {
          throw new AppError('COMMAND_FAILED', 'runner busy', { dispatched: 'no' });
        },
        captureSnapshot: async () => ({ nodes: [] }),
      },
    },
    ledger,
  );
  await bound.operations.captureSnapshot();
  assert.equal(ledger.dispatchedSteps, 0);
  await bound.operations.tapPoint();
  await bound.operations.tapPoint();
  assert.equal(ledger.dispatchedSteps, 2);
  await assert.rejects(bound.operations.typeText());
  assert.equal(ledger.dispatchedSteps, 2);
});

test('a request records into the ledger handed down to it, or a fresh one of its own', () => {
  const handedDown = createRequestDispatchLedger();
  assert.equal(
    requestDispatchLedger({ ...REQUEST, internal: { dispatchLedger: handedDown } }),
    handedDown,
  );
  assert.deepEqual(requestDispatchLedger(REQUEST), { dispatchedSteps: 0 });
});

test('a nested request records in its own ledger and moves its sends to the parent', async () => {
  const parent = createRequestDispatchLedger();
  let seen: DaemonRequest | undefined;
  const invoke = recordNestedRequests(async (req) => {
    seen = req;
    req.internal!.dispatchLedger!.dispatchedSteps += 1;
    return { ok: true, data: {} };
  }, parent);
  await invoke(REQUEST);
  assert.notEqual(seen?.internal?.dispatchLedger, parent);
  assert.equal(parent.dispatchedSteps, 1);
});

test('a failed nested response keeps only its producer steps, so the parent counts each send once', async () => {
  const parent = createRequestDispatchLedger();
  const failedAfter = (dispatchedSteps: number): DaemonResponse => ({
    ok: false,
    error: {
      code: 'COMMAND_FAILED',
      message: 'series failed',
      details: { dispatched: 'unknown', dispatchedSteps },
    },
  });
  const invoke = recordNestedRequests(async (req) => {
    req.internal!.dispatchLedger!.dispatchedSteps += 2;
    return req.command === 'press' ? failedAfter(3) : failedAfter(2);
  }, parent);
  const withProducerSteps = await invoke(REQUEST);
  assert.equal(parent.dispatchedSteps, 2);
  assert.deepEqual(!withProducerSteps.ok && withProducerSteps.error.details, {
    dispatched: 'unknown',
    dispatchedSteps: 1,
  });
  const ledgerStepsOnly = await invoke({ ...REQUEST, command: 'swipe' });
  assert.equal(parent.dispatchedSteps, 4);
  assert.deepEqual(!ledgerStepsOnly.ok && ledgerStepsOnly.error.details, { dispatched: 'unknown' });
});
