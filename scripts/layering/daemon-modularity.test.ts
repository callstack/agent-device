import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  checkDaemonModularityRatchets,
  DAEMON_MODULARITY_BASELINE,
  LOGICAL_MODULE_POLICIES,
  TYPE_CYCLE_BASELINE,
} from './daemon-modularity.ts';
import { SESSION_STATE_FIELD_OWNERS } from './session-state.ts';
import { resolveImportEdges, targetDagZone, type ResolvedImportEdge } from './model.ts';

function importEdge(file: string, target: string): ResolvedImportEdge {
  return {
    file,
    target,
    spec: target,
    line: 1,
    dynamic: false,
    typeOnly: true,
    fromZone: targetDagZone(file),
    toZone: targetDagZone(target),
  };
}

function baselineDaemonTypesEdges(): ResolvedImportEdge[] {
  return DAEMON_MODULARITY_BASELINE.externalDaemonTypesImporters.map((file) =>
    importEdge(file, 'src/daemon/types.ts'),
  );
}

function recordedMigrationEdges(): ResolvedImportEdge[] {
  return LOGICAL_MODULE_POLICIES.flatMap((module) =>
    (module.recordedMigrationImports ?? []).map((recorded) => {
      const [file, target] = recorded.split(' -> ');
      return importEdge(file!, target!);
    }),
  );
}

/** Every recorded import present and nothing else forbidden: the quiet state of the ratchets. */
function baselineEdges(): ResolvedImportEdge[] {
  return [...baselineDaemonTypesEdges(), ...recordedMigrationEdges()];
}

test('daemon modularity baseline records the measured R7 ownership pressure', () => {
  assert.equal(
    Object.keys(SESSION_STATE_FIELD_OWNERS).length,
    DAEMON_MODULARITY_BASELINE.sessionState.writerOwnedFields,
  );
  assert.equal(
    Object.values(SESSION_STATE_FIELD_OWNERS).reduce((sum, owners) => sum + owners.length, 0),
    DAEMON_MODULARITY_BASELINE.sessionState.ownerFileClaims,
  );
  assert.equal(TYPE_CYCLE_BASELINE, 76);
  assert.equal(DAEMON_MODULARITY_BASELINE.largestTypeCycle.zoneMembers['daemon-server'], 20);
  assert.equal('daemon' in DAEMON_MODULARITY_BASELINE.largestTypeCycle.zoneMembers, false);
});

test('external daemon/types.ts importer membership changes require the baseline to change', () => {
  const edges = resolveImportEdges(
    new Map([
      ['src/client/new-importer.ts', "import type { DaemonRequest } from '../daemon/types.ts';"],
      ['src/daemon/types.ts', 'export type DaemonRequest = { command: string };'],
    ]),
  );

  const violations = checkDaemonModularityRatchets([...baselineEdges(), ...edges], []);
  assert.equal(violations.length, 1);
  assert.match(violations[0]!.message, /may only shrink from the recorded 2/);

  const removed = checkDaemonModularityRatchets(
    [...baselineDaemonTypesEdges().slice(1), ...recordedMigrationEdges()],
    [],
  );
  assert.equal(removed.length, 1);
  assert.match(removed[0]!.message, /delete it from externalDaemonTypesImporters/);
});

test('planned logical modules start with zero forbidden imports', () => {
  const edges = resolveImportEdges(
    new Map([
      [
        'packages/replay-test/src/internal/scheduler.ts',
        "import type { Device } from '../../../../src/platforms/device.ts';",
      ],
      ['src/platforms/device.ts', 'export type Device = { id: string };'],
    ]),
  );

  const violations = checkDaemonModularityRatchets([...baselineEdges(), ...edges], []);
  assert.equal(violations.length, 1);
  assert.match(violations[0]!.message, /replay-test must not import/);
});

test('replay-test rejects request-global and engine-internal imports', () => {
  const edges = resolveImportEdges(
    new Map([
      [
        'packages/replay-test/src/internal/scheduler.ts',
        [
          "import { emitRequestProgress } from '../../../../src/request/progress.ts';",
          "import { readReplayScriptMetadata } from '../../../../src/replay/script.ts';",
          "import { parseMaestroProgram } from '../../../../src/compat/maestro/program-ir-parser.ts';",
        ].join('\n'),
      ],
      ['src/request/progress.ts', 'export function emitRequestProgress() {}'],
      ['src/replay/script.ts', 'export function readReplayScriptMetadata() {}'],
      ['src/compat/maestro/program-ir-parser.ts', 'export function parseMaestroProgram() {}'],
    ]),
  );

  const violations = checkDaemonModularityRatchets([...baselineEdges(), ...edges], []);
  assert.deepEqual(
    violations.map(({ message }) => message.replace(/;.*/, '')),
    [
      'replay-test must not import src/request/progress.ts',
      'replay-test must not import src/replay/script.ts',
      'replay-test must not import src/compat/maestro/program-ir-parser.ts',
    ],
  );
});

test('replay-test may still import its own files inside the package', () => {
  const edges = resolveImportEdges(
    new Map([
      [
        'packages/replay-test/src/internal/reporting.ts',
        "import { spec } from './reporters/spec.ts';",
      ],
      ['packages/replay-test/src/internal/reporters/spec.ts', 'export const spec = 1;'],
    ]),
  );

  assert.deepEqual(checkDaemonModularityRatchets([...baselineEdges(), ...edges], []), []);
});

// #1478 P3 cleared every recorded replay-test migration import: the ADR 0012 divergence
// vocabulary became a neutral contracts leaf, and the reporter tree now reads the progress
// wire vocabulary from contracts instead of request-global plumbing. The rule enforces
// unconditionally for replay-test from here on.
test('replay-test carries no recorded migration imports', () => {
  assert.equal(
    LOGICAL_MODULE_POLICIES.find(({ name }) => name === 'replay-test')?.recordedMigrationImports,
    undefined,
  );
  assert.deepEqual(
    LOGICAL_MODULE_POLICIES.flatMap((module) => module.recordedMigrationImports ?? []),
    [],
  );
  assert.deepEqual(checkDaemonModularityRatchets(baselineEdges(), []), []);
});

test('internal trees reject deep imports globally, including from daemon', () => {
  const edges = resolveImportEdges(
    new Map([
      ['src/daemon/adapter.ts', "import type { Plan } from '@agent-device/maestro/internal/plan';"],
      ['packages/maestro/src/internal/plan.ts', 'export type Plan = { steps: number };'],
    ]),
  );

  const violations = checkDaemonModularityRatchets([...baselineEdges(), ...edges], []);
  assert.equal(violations.length, 1);
  assert.match(violations[0]!.message, /must not import maestro's internal tree/);
});

test('R9 records zone ceilings and keeps engine files outside the largest component', () => {
  const commandMembers = Array.from(
    { length: DAEMON_MODULARITY_BASELINE.largestTypeCycle.zoneMembers.commands + 1 },
    (_, index) => `src/commands/probe-${index}.ts`,
  );
  const violations = checkDaemonModularityRatchets(baselineEdges(), [
    ...commandMembers,
    'src/ad-replay/internal/engine.ts',
  ]);

  assert.equal(violations.length, 3);
  assert.ok(violations.some(({ message }) => /contains 34 commands file/.test(message)));
  assert.ok(violations.some(({ message }) => /contains 1 ad-replay file/.test(message)));
  assert.ok(violations.some(({ message }) => /engine file entered/.test(message)));
});
