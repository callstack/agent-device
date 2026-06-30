import { test } from 'vitest';
import assert from 'node:assert/strict';
import {
  runBatch,
  validateAndNormalizeBatchSteps,
  type BatchRequest,
  type DaemonBatchStep,
} from '../batch.ts';
import type { DaemonResponse, ResponseLevel } from '../../kernel/contracts.ts';

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
