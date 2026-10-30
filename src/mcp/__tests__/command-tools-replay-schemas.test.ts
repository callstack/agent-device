import assert from 'node:assert/strict';
import { test } from 'vitest';
import type { ReplayCommandResult, ReplaySuiteResult } from '@agent-device/contracts/replay';
import { COMMAND_OUTPUT_SCHEMAS } from '@agent-device/command-surface';
import { validateAgainstSchema } from './output-schema-validator.ts';

const REPLAY_RESULT = {
  replayed: 7,
  healed: 1,
  session: 'demo',
  sessionActive: true,
  artifactPaths: ['/daemon/artifacts/flow.ad'],
  snapshotDiagnostics: {
    stats: { count: 3, p50Ms: 12, p95Ms: 40, maxMs: 40, slowThresholdMs: 100 },
  },
  message: 'Replayed 7 steps',
} satisfies ReplayCommandResult;

const SUITE_RESULT = {
  total: 2,
  executed: 1,
  passed: 1,
  failed: 0,
  skipped: 1,
  notRun: 1,
  durationMs: 1_200,
  failures: [],
  tests: [
    {
      file: '/repo/flow.ad',
      session: 'demo-1',
      status: 'passed',
      durationMs: 1_200,
      attempts: 1,
      replayed: 7,
      healed: 0,
    },
  ],
  snapshotDiagnostics: {
    stats: { count: 3, p50Ms: 12, p95Ms: 40, maxMs: 40, slowThresholdMs: 100 },
  },
} satisfies ReplaySuiteResult;

test('MCP replay outputSchema validates a full result and refuses a dropped required count', () => {
  assert.deepEqual(validateAgainstSchema(REPLAY_RESULT, COMMAND_OUTPUT_SCHEMAS.replay), []);

  const { healed: _dropped, ...withoutHealed } = REPLAY_RESULT;
  assert.deepEqual(validateAgainstSchema(withoutHealed, COMMAND_OUTPUT_SCHEMAS.replay), [
    '$.healed: missing required property',
  ]);
});

test('MCP test outputSchema validates a full suite result and refuses a dropped required count', () => {
  assert.deepEqual(validateAgainstSchema(SUITE_RESULT, COMMAND_OUTPUT_SCHEMAS.test), []);

  const { notRun: _dropped, ...withoutNotRun } = SUITE_RESULT;
  assert.deepEqual(validateAgainstSchema(withoutNotRun, COMMAND_OUTPUT_SCHEMAS.test), [
    '$.notRun: missing required property',
  ]);
});

test('MCP replay family output schemas stay non-strict for additive response fields', () => {
  assert.equal(COMMAND_OUTPUT_SCHEMAS.replay.additionalProperties, undefined);
  assert.equal(COMMAND_OUTPUT_SCHEMAS.test.additionalProperties, undefined);
  assert.deepEqual(
    validateAgainstSchema(
      { ...REPLAY_RESULT, warnings: ['stale ref frame'], cost: { wallClockMs: 12 } },
      COMMAND_OUTPUT_SCHEMAS.replay,
    ),
    [],
  );
});
