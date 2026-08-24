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

/** Where a member of `zone` lives, so a zone count can be turned back into file paths. */
const ZONE_DIRECTORY: Readonly<Record<string, string>> = {
  '(root)': 'src/',
  'daemon-server': 'src/daemon/',
  'ad-replay': 'packages/ad-replay/src/',
};

/**
 * A cycle membership that exactly fills the zone ceilings. R9 is equality-pinned, so a test
 * probing anything else starts from the pinned size the way `baselineEdges` starts from the
 * pinned edges; `overrides` re-counts one zone without disturbing the others.
 */
function baselineTypeCycleMembers(overrides: Readonly<Record<string, number>> = {}): string[] {
  const zones = { ...DAEMON_MODULARITY_BASELINE.largestTypeCycle.zoneMembers, ...overrides };
  return Object.entries(zones).flatMap(([zone, count]) =>
    Array.from(
      { length: count },
      (_, index) => `${ZONE_DIRECTORY[zone] ?? `src/${zone}/`}probe-${index}.ts`,
    ),
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
  assert.equal(TYPE_CYCLE_BASELINE, 20);
  assert.equal(DAEMON_MODULARITY_BASELINE.largestTypeCycle.zoneMembers['daemon-server'], 11);
  assert.equal('daemon' in DAEMON_MODULARITY_BASELINE.largestTypeCycle.zoneMembers, false);
});

test('external daemon/types.ts importer membership changes require the baseline to change', () => {
  const edges = resolveImportEdges(
    new Map([
      ['src/client/new-importer.ts', "import type { DaemonRequest } from '../daemon/types.ts';"],
      ['src/daemon/types.ts', 'export type DaemonRequest = { command: string };'],
    ]),
  );

  const violations = checkDaemonModularityRatchets(
    [...baselineEdges(), ...edges],
    baselineTypeCycleMembers(),
  );
  assert.equal(violations.length, 1);
  assert.match(violations[0]!.message, /may only shrink from the recorded 2/);

  const removed = checkDaemonModularityRatchets(
    [...baselineDaemonTypesEdges().slice(1), ...recordedMigrationEdges()],
    baselineTypeCycleMembers(),
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

  const violations = checkDaemonModularityRatchets(
    [...baselineEdges(), ...edges],
    baselineTypeCycleMembers(),
  );
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

  const violations = checkDaemonModularityRatchets(
    [...baselineEdges(), ...edges],
    baselineTypeCycleMembers(),
  );
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

  assert.deepEqual(
    checkDaemonModularityRatchets([...baselineEdges(), ...edges], baselineTypeCycleMembers()),
    [],
  );
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
  assert.deepEqual(checkDaemonModularityRatchets(baselineEdges(), baselineTypeCycleMembers()), []);
});

test('internal trees reject deep imports globally, including from daemon', () => {
  const edges = resolveImportEdges(
    new Map([
      ['src/daemon/adapter.ts', "import type { Plan } from '@agent-device/maestro/internal/plan';"],
      ['packages/maestro/src/internal/plan.ts', 'export type Plan = { steps: number };'],
    ]),
  );

  const violations = checkDaemonModularityRatchets(
    [...baselineEdges(), ...edges],
    baselineTypeCycleMembers(),
  );
  assert.equal(violations.length, 1);
  assert.match(violations[0]!.message, /must not import maestro's internal tree/);
});

test('R9 records zone ceilings and keeps engine files outside the largest component', () => {
  // One commands file and one engine file traded for two daemon-server ones, so the total
  // stays at the baseline and only the per-zone claims are on trial. `commands` left the cycle
  // entirely when screenshot stopped threading through generic dispatch, so its ceiling is 0.
  const zones = DAEMON_MODULARITY_BASELINE.largestTypeCycle.zoneMembers;
  const violations = checkDaemonModularityRatchets(
    baselineEdges(),
    baselineTypeCycleMembers({
      commands: 1,
      'ad-replay': 1,
      'daemon-server': zones['daemon-server']! - 2,
    }),
  );

  assert.equal(violations.length, 3);
  assert.ok(violations.some(({ message }) => /contains 1 commands file/.test(message)));
  assert.ok(violations.some(({ message }) => /contains 1 ad-replay file/.test(message)));
  assert.ok(violations.some(({ message }) => /engine file entered/.test(message)));
});

// #1837: the zone violation used to name the alphabetically-first zone member — a file that had
// been in the cycle all along — so the +1 was found only by diffing member lists between commits.
// The ceiling records a count, not a membership, so the message lists every zone member instead.
test('R10 zone overflow lists the whole zone so the joining member is visible', () => {
  const zones = DAEMON_MODULARITY_BASELINE.largestTypeCycle.zoneMembers;
  // Sorts after the daemon-server probes: the old first-member pick could not name it by luck.
  const joined = 'src/daemon/snapshot-interactor-capture.ts';
  // `commands` left the cycle with the screenshot cutover, so the offsetting removal comes from
  // `core` instead: the total stays at the baseline and only the daemon-server claim is on trial.
  const members = [...baselineTypeCycleMembers({ core: zones.core! - 1 }), joined].sort();
  const daemonMembers = members.filter((member) => member.startsWith('src/daemon/'));
  assert.notEqual(daemonMembers[0], joined);

  const violations = checkDaemonModularityRatchets(baselineEdges(), members);

  assert.equal(violations.length, 1);
  const [violation] = violations;
  assert.equal(violation!.rule, 'R10 daemon-modularity');
  assert.equal(violation!.file, 'scripts/layering/daemon-modularity.ts');
  assert.match(violation!.message, /contains 12 daemon-server file\(s\) \(baseline 11\)/);
  for (const member of daemonMembers) {
    assert.ok(violation!.message.includes(member), `${member} missing from: ${violation!.message}`);
  }
  assert.match(violation!.message, /1 over the ceiling — the member\(s\) that joined are among/);
});

// Growth was always rejected; a baseline left ABOVE the measured size used to be a suggestion
// in the success line, which is headroom the next change spends without a number moving.
test('R9 rejects a baseline left above the measured cycle', () => {
  const zones = DAEMON_MODULARITY_BASELINE.largestTypeCycle.zoneMembers;
  const violations = checkDaemonModularityRatchets(
    baselineEdges(),
    baselineTypeCycleMembers({ 'daemon-server': zones['daemon-server']! - 1 }),
  );

  assert.equal(violations.length, 1);
  assert.match(violations[0]!.rule, /^R9 /);
  assert.match(violations[0]!.message, /dropped to 19 files \(baseline 20\)/);
  assert.match(violations[0]!.message, /Lower LARGEST_TYPE_CYCLE_ZONE_CEILINGS by the same 1/);
});
