import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  checkDaemonModularityRatchets,
  checkRetiredInteractionPaths,
  checkRetiredSessionLifecyclePaths,
  checkRetiredSessionObservabilityPaths,
  checkRetiredSnapshotExecutionPaths,
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
    symbols: [],
    fromZone: targetDagZone(file),
    toZone: targetDagZone(target),
  };
}

function baselineDaemonTypesEdges(): ResolvedImportEdge[] {
  return DAEMON_MODULARITY_BASELINE.externalDaemonTypesImporters.map((file) =>
    importEdge(file, 'src/daemon/types.ts'),
  );
}

/** Every baseline edge is present and nothing else is forbidden: the quiet state of the ratchets. */
function baselineEdges(): ResolvedImportEdge[] {
  return baselineDaemonTypesEdges();
}

/** Where a member of `zone` lives, so a zone count can be turned back into file paths. */
const ZONE_DIRECTORY: Readonly<Record<string, string>> = {
  '(root)': 'src/',
  'daemon-server': 'src/daemon/',
  'ad-replay': 'packages/ad-replay/src/',
  'provider-webdriver': 'packages/provider-webdriver/src/',
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
  assert.equal(TYPE_CYCLE_BASELINE, 6);
  assert.equal(DAEMON_MODULARITY_BASELINE.largestTypeCycle.zoneMembers['provider-webdriver'], 6);
  assert.equal('daemon-server' in DAEMON_MODULARITY_BASELINE.largestTypeCycle.zoneMembers, false);
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
    baselineDaemonTypesEdges().slice(1),
    baselineTypeCycleMembers(),
  );
  assert.equal(removed.length, 1);
  assert.match(removed[0]!.message, /delete it from externalDaemonTypesImporters/);
});

test('logical modules reject forbidden imports', () => {
  const edges = resolveImportEdges(
    new Map([
      [
        'packages/replay-test/src/internal/scheduler.ts',
        "import type { Device } from '../../../../src/providers/device.ts';",
      ],
      ['src/providers/device.ts', 'export type Device = { id: string };'],
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
          "import { readReplayScriptMetadata } from '../../../../src/daemon/replay/internal/native-command.ts';",
          "import { parseMaestroProgram } from '../../../../src/compat/maestro/program-ir-parser.ts';",
        ].join('\n'),
      ],
      ['src/request/progress.ts', 'export function emitRequestProgress() {}'],
      [
        'src/daemon/replay/internal/native-command.ts',
        'export function readReplayScriptMetadata() {}',
      ],
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
      "packages/replay-test/src/internal/scheduler.ts must not import daemon-replay's internal tree (src/daemon/replay/internal/native-command.ts)",
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

test('daemon replay rejects handler, owner, session-store, and engine deep edges', () => {
  const edges = resolveImportEdges(
    new Map([
      [
        'src/daemon/handlers/session.ts',
        "import { runReplayCommand } from '../replay/internal/native-command.ts';",
      ],
      [
        'src/daemon/replay/internal/test-command.ts',
        "import { handleSessionCloseCommands } from '../../session-lifecycle/internal/session-close.ts';",
      ],
      [
        'src/daemon/replay/internal/close-command.ts',
        "import { handleSessionCloseCommands } from '../../session-lifecycle/index.ts';",
      ],
      [
        'src/daemon/replay/internal/command-types.ts',
        "import { SessionStore } from '../../session-store.ts';",
      ],
      [
        'packages/ad-replay/src/internal/step-loop.ts',
        "import { runReplayCommand } from '../../../../src/daemon/replay/internal/native-command.ts';",
      ],
      ['src/daemon/replay/internal/native-command.ts', 'export function runReplayCommand() {}'],
      [
        'src/daemon/session-lifecycle/internal/session-close.ts',
        'export function handleSessionCloseCommands() {}',
      ],
      ['src/daemon/session-lifecycle/index.ts', 'export function handleSessionCloseCommands() {}'],
      ['src/daemon/session-store.ts', 'export class SessionStore {}'],
    ]),
  );

  const violations = checkDaemonModularityRatchets(
    [...baselineEdges(), ...edges],
    baselineTypeCycleMembers(),
  );
  assert.deepEqual(
    violations.map(({ file, line, message }) => ({
      file,
      line,
      message: message.replace(/;.*/, ''),
    })),
    [
      {
        file: 'src/daemon/handlers/session.ts',
        line: 1,
        message:
          "src/daemon/handlers/session.ts must not import daemon-replay's internal tree (src/daemon/replay/internal/native-command.ts)",
      },
      {
        file: 'src/daemon/replay/internal/test-command.ts',
        line: 1,
        message:
          "src/daemon/replay/internal/test-command.ts must not import daemon-session-lifecycle's internal tree (src/daemon/session-lifecycle/internal/session-close.ts)",
      },
      {
        file: 'src/daemon/replay/internal/close-command.ts',
        line: 1,
        message: 'daemon-replay must not import src/daemon/session-lifecycle/index.ts',
      },
      {
        file: 'src/daemon/replay/internal/command-types.ts',
        line: 1,
        message: 'daemon-replay must not import src/daemon/session-store.ts',
      },
      {
        file: 'packages/ad-replay/src/internal/step-loop.ts',
        line: 1,
        message:
          "packages/ad-replay/src/internal/step-loop.ts must not import daemon-replay's internal tree (src/daemon/replay/internal/native-command.ts)",
      },
    ],
  );
});

test('session lifecycle rejects handler deep imports in both directions', () => {
  const edges = resolveImportEdges(
    new Map([
      [
        'src/daemon/handlers/session.ts',
        "import { handleSessionInventoryCommands } from '../session-lifecycle/internal/inventory.ts';\nexport function handleSessionCommands() {}",
      ],
      [
        'src/daemon/session-lifecycle/internal/inventory.ts',
        "import { handleSessionCommands } from '../../handlers/session.ts';\nexport function handleSessionInventoryCommands() {}",
      ],
      [
        'src/daemon/session-lifecycle/internal/session-close.ts',
        "import { handleSessionCommands } from '../../handlers/session.ts';",
      ],
      [
        'src/daemon/session-lifecycle/index.ts',
        'export function handleSessionInventoryCommands() {}',
      ],
    ]),
  );

  const violations = checkDaemonModularityRatchets(
    [...baselineEdges(), ...edges],
    baselineTypeCycleMembers(),
  );
  assert.deepEqual(
    violations.map(({ file, line, message }) => ({
      file,
      line,
      message: message.replace(/;.*/, ''),
    })),
    [
      {
        file: 'src/daemon/handlers/session.ts',
        line: 1,
        message:
          "src/daemon/handlers/session.ts must not import daemon-session-lifecycle's internal tree (src/daemon/session-lifecycle/internal/inventory.ts)",
      },
      {
        file: 'src/daemon/session-lifecycle/internal/inventory.ts',
        line: 1,
        message: 'daemon-session-lifecycle must not import src/daemon/handlers/session.ts',
      },
      {
        file: 'src/daemon/session-lifecycle/internal/session-close.ts',
        line: 1,
        message: 'daemon-session-lifecycle must not import src/daemon/handlers/session.ts',
      },
    ],
  );
});

test('interaction rejects handler crossings and deep imports around its facade', () => {
  const edges = resolveImportEdges(
    new Map([
      [
        'src/daemon/handlers/react-native.ts',
        "import { refSnapshotFlagGuardResponse } from '../interaction/internal/interaction-flags.ts';\nexport function handleReactNativeCommands() {}",
      ],
      [
        'src/daemon/interaction/internal/interaction-runtime.ts',
        "import { handleReactNativeCommands } from '../../handlers/react-native.ts';\nexport function createInteractionRuntime() {}",
      ],
      [
        'src/daemon/generic-settle.ts',
        "import { createInteractionRuntime } from './interaction/internal/interaction-runtime.ts';",
      ],
      [
        'src/daemon/selector-runtime.ts',
        "import { refSnapshotFlagGuardResponse } from './interaction/internal/interaction-flags.ts';",
      ],
      [
        'src/daemon/selector-runtime-backend.ts',
        "import { readTextForNode } from './interaction/internal/interaction-ref-policy.ts';",
      ],
      [
        'src/daemon/interaction/internal/interaction-flags.ts',
        'export function refSnapshotFlagGuardResponse() {}',
      ],
      [
        'src/daemon/interaction/internal/interaction-ref-policy.ts',
        'export function readTextForNode() {}',
      ],
    ]),
  );

  const violations = checkDaemonModularityRatchets(
    [...baselineEdges(), ...edges],
    baselineTypeCycleMembers(),
  );
  assert.equal(violations.length, 5);
  assert.ok(
    violations.some(({ message }) =>
      message.includes(
        "src/daemon/handlers/react-native.ts must not import daemon-interaction's internal tree",
      ),
    ),
  );
  assert.ok(
    violations.some(({ message }) =>
      message.includes(
        "src/daemon/interaction/internal/interaction-runtime.ts must not import src/daemon/handlers/react-native.ts from daemon-interaction's internal tree",
      ),
    ),
  );
  assert.equal(
    violations.filter(({ message }) =>
      message.includes("must not import daemon-interaction's internal tree"),
    ).length,
    4,
  );
});

test('session observability rejects handler deep imports in both directions', () => {
  const edges = resolveImportEdges(
    new Map([
      [
        'src/daemon/handlers/session.ts',
        "import { handleSessionObservabilityCommands } from '../session-observability/internal/session-observability.ts';\nexport function handleSessionCommands() {}",
      ],
      [
        'src/daemon/session-observability/internal/session-observability.ts',
        "import { handleSessionCommands } from '../../handlers/session.ts';\nexport function handleSessionObservabilityCommands() {}",
      ],
      [
        'src/daemon/session-observability/index.ts',
        'export function handleSessionObservabilityCommands() {}',
      ],
    ]),
  );

  const violations = checkDaemonModularityRatchets(
    [...baselineEdges(), ...edges],
    baselineTypeCycleMembers(),
  );
  assert.deepEqual(
    violations.map(({ file, line, message }) => ({
      file,
      line,
      message: message.replace(/;.*/, ''),
    })),
    [
      {
        file: 'src/daemon/handlers/session.ts',
        line: 1,
        message:
          "src/daemon/handlers/session.ts must not import daemon-session-observability's internal tree (src/daemon/session-observability/internal/session-observability.ts)",
      },
      {
        file: 'src/daemon/session-observability/internal/session-observability.ts',
        line: 1,
        message: 'daemon-session-observability must not import src/daemon/handlers/session.ts',
      },
    ],
  );
});

test('snapshot execution cannot return to handler-owned support paths', () => {
  const restored = [
    'src/daemon/handlers/snapshot-capture.ts',
    'src/daemon/handlers/snapshot-interactor-capture.ts',
    'src/daemon/handlers/snapshot-session.ts',
  ];

  assert.deepEqual(
    checkRetiredSnapshotExecutionPaths(restored).map(({ file, message }) => ({ file, message })),
    restored.map((file) => ({
      file,
      message:
        `retired snapshot execution handler path was restored: ${file}. ` +
        'Reuse the daemon-owned snapshot execution module instead of restoring shared mechanics beneath a route adapter.',
    })),
  );
  assert.deepEqual(checkRetiredSnapshotExecutionPaths(['src/daemon/handlers/snapshot.ts']), []);
});

test('session lifecycle rejects restored neutral helper paths', () => {
  const violations = checkRetiredSessionLifecyclePaths([
    'src/daemon/session-device-resolution.ts',
    'src/daemon/handlers/session-device-utils.ts',
    'src/daemon/handlers/session-runtime-admission.ts',
    'src/daemon/handlers/session-close-script.ts',
    'src/daemon/handlers/session-close.ts',
  ]);

  assert.deepEqual(
    violations.map(({ message }) => message),
    [
      'retired session lifecycle path was restored: src/daemon/handlers/session-device-utils.ts. Keep the neutral seam at its daemon owner instead of rebuilding a handler grab-bag.',
      'retired session lifecycle path was restored: src/daemon/handlers/session-runtime-admission.ts. Keep the neutral seam at its daemon owner instead of rebuilding a handler grab-bag.',
      'retired session lifecycle path was restored: src/daemon/handlers/session-close-script.ts. Keep the neutral seam at its daemon owner instead of rebuilding a handler grab-bag.',
      'retired session lifecycle path was restored: src/daemon/handlers/session-close.ts. Keep the neutral seam at its daemon owner instead of rebuilding a handler grab-bag.',
    ],
  );
});

test('interaction rejects restored handler implementation paths', () => {
  const violations = checkRetiredInteractionPaths([
    'src/daemon/interaction/internal/interaction.ts',
    'src/daemon/handlers/interaction-touch.ts',
  ]);

  assert.deepEqual(violations, [
    {
      rule: 'R10 daemon-modularity',
      file: 'src/daemon/handlers/interaction-touch.ts',
      line: 1,
      message:
        'retired interaction handler path was restored: src/daemon/handlers/interaction-touch.ts. Keep route implementations behind src/daemon/interaction/index.ts instead of rebuilding a handler-owned interaction surface.',
    },
  ]);
});

test('interaction rejects renamed handler implementation paths', () => {
  const violations = checkRetiredInteractionPaths([
    'src/daemon/handlers/interaction-touch-v2.ts',
    'src/daemon/handlers/find-next.ts',
  ]);

  assert.deepEqual(
    violations.map(({ file, message }) => ({ file, message })),
    [
      {
        file: 'src/daemon/handlers/interaction-touch-v2.ts',
        message:
          'retired interaction handler path was restored: src/daemon/handlers/interaction-touch-v2.ts. Keep route implementations behind src/daemon/interaction/index.ts instead of rebuilding a handler-owned interaction surface.',
      },
      {
        file: 'src/daemon/handlers/find-next.ts',
        message:
          'retired interaction handler path was restored: src/daemon/handlers/find-next.ts. Keep route implementations behind src/daemon/interaction/index.ts instead of rebuilding a handler-owned interaction surface.',
      },
    ],
  );
});

test('session lifecycle rejects any restored open or close handler path', () => {
  const violations = checkRetiredSessionLifecyclePaths([
    'src/daemon/handlers/session-open-regressed.ts',
    'src/daemon/handlers/session-close-regressed.ts',
  ]);

  assert.deepEqual(
    violations.map(({ file, message }) => ({
      rule: 'R10 daemon-modularity',
      file,
      line: 1,
      message,
    })),
    [
      {
        rule: 'R10 daemon-modularity',
        file: 'src/daemon/handlers/session-open-regressed.ts',
        line: 1,
        message:
          'retired session lifecycle path was restored: src/daemon/handlers/session-open-regressed.ts. Keep the neutral seam at its daemon owner instead of rebuilding a handler grab-bag.',
      },
      {
        rule: 'R10 daemon-modularity',
        file: 'src/daemon/handlers/session-close-regressed.ts',
        line: 1,
        message:
          'retired session lifecycle path was restored: src/daemon/handlers/session-close-regressed.ts. Keep the neutral seam at its daemon owner instead of rebuilding a handler grab-bag.',
      },
    ],
  );
});

test('session observability rejects restored handler paths', () => {
  const restoredPaths = [
    'src/daemon/handlers/session-observability.ts',
    'src/daemon/handlers/session-perf-runtime.ts',
    'src/daemon/handlers/session-network.ts',
    'src/daemon/handlers/session-audio.ts',
    'src/daemon/handlers/session-network-regressed.ts',
    'src/daemon/handlers/session-perf.ts',
    'src/daemon/handlers/session-logs.ts',
    'src/daemon/handlers/session-events.ts',
  ] as const;
  const violations = checkRetiredSessionObservabilityPaths(restoredPaths);

  assert.deepEqual(
    violations.map(({ file, message }) => ({ file, message })),
    restoredPaths.map((file) => ({
      file,
      message:
        `retired session observability path was restored: ${file}. ` +
        'Keep the neutral seam at its daemon owner instead of rebuilding a handler grab-bag.',
    })),
  );
});

test('R9 records zone ceilings and keeps engine files outside the largest component', () => {
  // One commands file and one engine file traded for two provider-webdriver ones, so the
  // total stays at the baseline and only the per-zone claims are on trial.
  const zones = DAEMON_MODULARITY_BASELINE.largestTypeCycle.zoneMembers;
  const violations = checkDaemonModularityRatchets(
    baselineEdges(),
    baselineTypeCycleMembers({
      commands: 1,
      'ad-replay': 1,
      'provider-webdriver': zones['provider-webdriver']! - 2,
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
  // Sorts after the provider-webdriver probes: the old first-member pick could not name it by luck.
  const joined = 'src/daemon/snapshot-interactor-capture.ts';
  const members = [
    ...baselineTypeCycleMembers({ 'provider-webdriver': zones['provider-webdriver']! - 1 }),
    joined,
  ].sort();
  const daemonMembers = members.filter((member) => member.startsWith('src/daemon/'));
  assert.deepEqual(daemonMembers, [joined]);

  const violations = checkDaemonModularityRatchets(baselineEdges(), members);

  assert.equal(violations.length, 1);
  const [violation] = violations;
  assert.equal(violation!.rule, 'R10 daemon-modularity');
  assert.equal(violation!.file, 'scripts/layering/daemon-modularity.ts');
  assert.match(violation!.message, /contains 1 daemon-server file\(s\) \(baseline 0\)/);
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
    baselineTypeCycleMembers({ 'provider-webdriver': zones['provider-webdriver']! - 1 }),
  );

  assert.equal(violations.length, 1);
  assert.match(violations[0]!.rule, /^R9 /);
  assert.match(violations[0]!.message, /dropped to 5 files \(baseline 6\)/);
  assert.match(violations[0]!.message, /Lower LARGEST_TYPE_CYCLE_ZONE_CEILINGS by the same 1/);
});
