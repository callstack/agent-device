import assert from 'node:assert/strict';
import { test } from 'vitest';
import type { ReplayCommandResult, ReplaySuiteResult } from '@agent-device/contracts/replay';
import { ownerFilesForCommand } from '@agent-device/command-registry/owner-files';
import { REPLAY_COMMAND_OUTPUT_SCHEMAS } from '../../commands/replay/index.ts';
import { COMMAND_OUTPUT_SCHEMAS } from '../command-output-schemas.ts';
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

test('MCP replay family output schemas are the family module entries, not copies', () => {
  assert.equal(COMMAND_OUTPUT_SCHEMAS.replay, REPLAY_COMMAND_OUTPUT_SCHEMAS.replay);
  assert.equal(COMMAND_OUTPUT_SCHEMAS.test, REPLAY_COMMAND_OUTPUT_SCHEMAS.test);
});

test('the projected family map declares exactly the commands its module owns', () => {
  const commands = Object.keys(REPLAY_COMMAND_OUTPUT_SCHEMAS) as ['replay', 'test'];
  assert.deepEqual(commands, ['replay', 'test']);
  for (const command of commands) {
    assert.ok(
      ownerFilesForCommand(command).includes('src/commands/replay/index.ts'),
      `${command} projects its output schema from this module but does not name it as its owner`,
    );
  }
});

/**
 * A projected family is spread into the base map, so two families naming one command would resolve
 * last-wins with nothing to complain about: the composed map still satisfies
 * `Record<keyof CommandResultMap, JsonSchema>` and publishes whichever schema spread last. Totality
 * stays the compiler's; this owns the shadowing half. Every family the seam spreads is listed here,
 * so registering a new family is the migration step.
 */
const PROJECTED_FAMILIES = [{ name: 'replay', schemas: REPLAY_COMMAND_OUTPUT_SCHEMAS }] as const;

test('projected output-schema families claim disjoint commands and survive the composition intact', () => {
  const claimedBy = new Map<string, string>();
  for (const family of PROJECTED_FAMILIES) {
    for (const command of Object.keys(family.schemas)) {
      const previous = claimedBy.get(command);
      assert.equal(
        previous,
        undefined,
        `${command} is claimed by both ${previous} and ${family.name}; the later spread would win silently`,
      );
      claimedBy.set(command, family.name);
    }
  }
  for (const family of PROJECTED_FAMILIES) {
    for (const [command, schema] of Object.entries(family.schemas)) {
      assert.equal(
        COMMAND_OUTPUT_SCHEMAS[command as keyof typeof COMMAND_OUTPUT_SCHEMAS],
        schema,
        `${family.name}.${command} is not the schema the map publishes`,
      );
    }
  }
});

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
