import assert from 'node:assert/strict';
import { test } from 'vitest';
import { AppError } from '@agent-device/kernel/errors';
import {
  networkAdmissionUse,
  networkDumpUse,
  resolveNetworkRuntimePlan,
} from './network-runtime-plan.ts';

test('freezes the exact two action aliases by four include-mode projection cells', () => {
  const projectionCells = ['dump', 'log'].flatMap((action) =>
    ['summary', 'headers', 'body', 'all'].map((include) =>
      resolveNetworkRuntimePlan({ action, include }),
    ),
  );
  assert.deepEqual(projectionCells, [
    { action: 'dump', include: 'summary', use: networkDumpUse },
    { action: 'dump', include: 'headers', use: networkDumpUse },
    { action: 'dump', include: 'body', use: networkDumpUse },
    { action: 'dump', include: 'all', use: networkDumpUse },
    { action: 'log', include: 'summary', use: networkDumpUse },
    { action: 'log', include: 'headers', use: networkDumpUse },
    { action: 'log', include: 'body', use: networkDumpUse },
    { action: 'log', include: 'all', use: networkDumpUse },
  ]);
  assert.equal(
    projectionCells.every((cell) => Object.isFrozen(cell)),
    true,
  );
});

test('normalizes defaults and retains the requested alias and projection', () => {
  assert.deepEqual(resolveNetworkRuntimePlan({}), {
    action: 'dump',
    include: 'summary',
    use: networkDumpUse,
  });
  assert.deepEqual(resolveNetworkRuntimePlan({ action: 'LOG', include: 'HEADERS' }), {
    action: 'log',
    include: 'headers',
    use: networkDumpUse,
  });
  assert.deepEqual(networkDumpUse, {
    required: ['networkDump'],
    preferred: [],
  });
  assert.deepEqual(networkAdmissionUse, {
    required: [],
    preferred: ['networkDump'],
  });
});

test('rejects actions and projections outside the frozen cells', () => {
  for (const input of [{ action: 'stream' }, { include: 'cookies' }]) {
    assert.throws(
      () => resolveNetworkRuntimePlan(input),
      (error) => error instanceof AppError && error.code === 'INVALID_ARGS',
    );
  }
});
