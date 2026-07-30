import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  checkDaemonModularityRatchets,
  DAEMON_MODULARITY_BASELINE,
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

  const violations = checkDaemonModularityRatchets([...baselineDaemonTypesEdges(), ...edges], []);
  assert.equal(violations.length, 1);
  assert.match(violations[0]!.message, /may only shrink from the recorded 4/);

  const removed = checkDaemonModularityRatchets(baselineDaemonTypesEdges().slice(1), []);
  assert.equal(removed.length, 1);
  assert.match(removed[0]!.message, /delete it from externalDaemonTypesImporters/);
});

test('planned logical modules start with zero forbidden imports', () => {
  const edges = resolveImportEdges(
    new Map([
      ['src/replay/test/scheduler.ts', "import type { Device } from '../../platforms/device.ts';"],
      ['src/platforms/device.ts', 'export type Device = { id: string };'],
    ]),
  );

  const violations = checkDaemonModularityRatchets([...baselineDaemonTypesEdges(), ...edges], []);
  assert.equal(violations.length, 1);
  assert.match(violations[0]!.message, /replay-test must not import/);
});

test('internal trees reject deep imports globally, including from daemon', () => {
  const edges = resolveImportEdges(
    new Map([
      ['src/daemon/adapter.ts', "import type { Plan } from '../maestro/internal/plan.ts';"],
      ['src/maestro/internal/plan.ts', 'export type Plan = { steps: number };'],
    ]),
  );

  const violations = checkDaemonModularityRatchets([...baselineDaemonTypesEdges(), ...edges], []);
  assert.equal(violations.length, 1);
  assert.match(violations[0]!.message, /must not import maestro's internal tree/);
});

test('R9 records zone ceilings and keeps engine files outside the largest component', () => {
  const commandMembers = Array.from(
    { length: DAEMON_MODULARITY_BASELINE.largestTypeCycle.zoneMembers.commands + 1 },
    (_, index) => `src/commands/probe-${index}.ts`,
  );
  const violations = checkDaemonModularityRatchets(baselineDaemonTypesEdges(), [
    ...commandMembers,
    'src/ad-replay/internal/engine.ts',
  ]);

  assert.equal(violations.length, 3);
  assert.ok(violations.some(({ message }) => /contains 34 commands file/.test(message)));
  assert.ok(violations.some(({ message }) => /contains 1 ad-replay file/.test(message)));
  assert.ok(violations.some(({ message }) => /engine file entered/.test(message)));
});
