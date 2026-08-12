import type { DaemonBatchStep } from '@agent-device/contracts/command';
import { test } from 'vitest';
import assert from 'node:assert/strict';
import { runBatch, validateAndNormalizeBatchSteps, type BatchRequest } from '../batch.ts';
import type { DaemonResponse, ResponseLevel } from '@agent-device/kernel/contracts';

test('validateAndNormalizeBatchSteps rejects unknown top-level step fields', () => {
  assert.throws(
    () =>
      validateAndNormalizeBatchSteps(
        [
          {
            command: 'open',
            positionals: ['Settings'],
            args: ['unexpected'],
          } as unknown as DaemonBatchStep,
        ],
        10,
      ),
    /unknown field\(s\): "args"/i,
  );
});

test('validateAndNormalizeBatchSteps blocks replay daemon steps', () => {
  assert.throws(
    () => validateAndNormalizeBatchSteps([{ command: 'replay' }], 10),
    /cannot run replay/i,
  );
});

test('validateAndNormalizeBatchSteps validates runtime hints', () => {
  assert.throws(
    () =>
      validateAndNormalizeBatchSteps(
        [{ command: 'open', runtime: { platform: 'web' } } as unknown as DaemonBatchStep],
        10,
      ),
    /runtime is invalid/i,
  );
});

// Records the responseLevel each step is invoked with, so the Phase 4
// intermediate-step elision can be asserted end to end.
function recordingInvoke(seen: (ResponseLevel | undefined)[]) {
  return async (req: BatchRequest): Promise<DaemonResponse> => {
    seen.push(req.meta?.responseLevel);
    return { ok: true, data: { command: req.command } };
  };
}

function batchRequest(commands: string[], responseLevel?: ResponseLevel): BatchRequest {
  return {
    token: 't',
    command: 'batch',
    positionals: [],
    flags: { batchSteps: commands.map((command) => ({ command })) },
    ...(responseLevel ? { meta: { responseLevel } } : {}),
  };
}

test('batch preserves typed error recovery signals from a failing step', async () => {
  const response = await runBatch(batchRequest(['open']), 'session', async () => ({
    ok: false,
    error: {
      code: 'DEVICE_IN_USE',
      message: 'device busy',
      retriable: true,
      supportedOn: 'android, web',
    },
  }));

  assert.equal(response.ok, false);
  if (response.ok) return;
  assert.equal(response.error.retriable, true);
  assert.equal(response.error.supportedOn, 'android, web');
});

test('batch keeps unknown typed error recovery signals absent', async () => {
  const response = await runBatch(batchRequest(['open']), 'session', async () => ({
    ok: false,
    error: {
      code: 'INVALID_ARGS',
      message: 'bad args',
    },
  }));

  assert.equal(response.ok, false);
  if (response.ok) return;
  assert.equal('retriable' in response.error, false);
  assert.equal('supportedOn' in response.error, false);
});

test('batch elides intermediate steps to digest, final step keeps requested level (full)', async () => {
  const seen: (ResponseLevel | undefined)[] = [];
  const response = await runBatch(
    batchRequest(['snapshot', 'find', 'get'], 'full'),
    'session',
    recordingInvoke(seen),
  );
  assert.equal(response.ok, true);
  assert.deepEqual(seen, ['digest', 'digest', 'full']);
});

test('batch at digest keeps every step at digest', async () => {
  const seen: (ResponseLevel | undefined)[] = [];
  await runBatch(batchRequest(['snapshot', 'find'], 'digest'), 'session', recordingInvoke(seen));
  assert.deepEqual(seen, ['digest', 'digest']);
});

test('a single-step batch never elides (the only step is final)', async () => {
  const seen: (ResponseLevel | undefined)[] = [];
  await runBatch(batchRequest(['snapshot'], 'full'), 'session', recordingInvoke(seen));
  assert.deepEqual(seen, ['full']);
});

test('default batch (no responseLevel) passes meta through unchanged — byte-identical', async () => {
  const seen: (ResponseLevel | undefined)[] = [];
  await runBatch(batchRequest(['snapshot', 'find', 'get']), 'session', recordingInvoke(seen));
  assert.deepEqual(seen, [undefined, undefined, undefined]);
});
