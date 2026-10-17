import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  checkDaemonModularityRatchets,
  checkRetiredInteractionPaths,
  checkRetiredSessionLifecyclePaths,
  checkRetiredSessionObservabilityPaths,
  checkRetiredSnapshotExecutionPaths,
} from './daemon-modularity.ts';
import { resolveImportEdges, type ResolvedImportEdge } from './model.ts';
import type { LayeringRatchets } from './ratchet-reference.ts';

/** The quiet state of the ratchets: no forbidden edge present. */
function baselineEdges(): ResolvedImportEdge[] {
  return [];
}

/** Where a member of `zone` lives, so a zone count can be turned back into file paths. */
const ZONE_DIRECTORY: Readonly<Record<string, string>> = {
  '(root)': 'src/',
  'daemon-server': 'packages/daemon/src/',
  'ad-replay': 'packages/ad-replay/src/',
  'provider-webdriver': 'packages/provider-webdriver/src/',
};

/** A cycle membership of `count` files per zone, so a zone count becomes file paths. */
function typeCycleMembers(zones: Readonly<Record<string, number>>): string[] {
  return Object.entries(zones).flatMap(([zone, count]) =>
    Array.from(
      { length: count },
      (_, index) => `${ZONE_DIRECTORY[zone] ?? `src/${zone}/`}probe-${index}.ts`,
    ),
  );
}

/**
 * The merge-base measurement every test ratchets against. R9 and R10's R7 counts have no recorded
 * numbers any more, so a test states its own reference tree instead of importing one.
 */
const REFERENCE: LayeringRatchets = {
  typeInversions: {},
  largestTypeCycle: typeCycleMembers({ 'provider-webdriver': 6 }),
  sessionState: { writerOwnedFields: 19, ownerFileClaims: 22 },
};

/** The same measurement as the reference except where a test moves one number. */
function measured(overrides: Partial<LayeringRatchets> = {}): LayeringRatchets {
  return { ...REFERENCE, ...overrides };
}

test('R10 rejects R7 ownership pressure that grew past the merge-base', () => {
  const grownFields = checkDaemonModularityRatchets(
    baselineEdges(),
    measured({ sessionState: { writerOwnedFields: 20, ownerFileClaims: 23 } }),
    REFERENCE,
  );
  assert.deepEqual(
    grownFields.map(({ rule, message }) => ({ rule, message })),
    [
      {
        rule: 'R10 daemon-modularity',
        message:
          'R7 writerOwnedFields grew to 20 (baseline 19 at the merge-base). Route the new write ' +
          'through an existing owner instead.',
      },
      {
        rule: 'R10 daemon-modularity',
        message:
          'R7 ownerFileClaims grew to 23 (baseline 22 at the merge-base). Route the new write ' +
          'through an existing owner instead.',
      },
    ],
  );
});

test('R10 banks an R7 shrink with no edit anywhere', () => {
  assert.deepEqual(
    checkDaemonModularityRatchets(
      baselineEdges(),
      measured({ sessionState: { writerOwnedFields: 18, ownerFileClaims: 20 } }),
      REFERENCE,
    ),
    [],
  );
});

test('a production import of the daemon request/session-state modules outside the daemon is red', () => {
  const edges = resolveImportEdges(
    new Map([
      [
        'src/commands/new-importer.ts',
        "import type { SessionState } from '../../packages/daemon/src/core/session-state.ts';",
      ],
      ['packages/daemon/src/core/session-state.ts', 'export type SessionState = { name: string };'],
    ]),
  );

  const violations = checkDaemonModularityRatchets(edges, REFERENCE, REFERENCE);
  assert.equal(violations.length, 1);
  assert.match(violations[0]!.message, /src\/commands\/new-importer\.ts imports a daemon request/);
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
    REFERENCE,
    REFERENCE,
  );
  assert.equal(violations.length, 1);
  assert.match(violations[0]!.message, /replay-test must not import/);
});

test('replay-test rejects request-global and replay-port imports', () => {
  const edges = resolveImportEdges(
    new Map([
      [
        'packages/replay-test/src/internal/scheduler.ts',
        [
          "import { emitRequestProgress } from '../../../../src/request/progress.ts';",
          "import { runReplayCommand } from '../../../replay-port/src/daemon-port/native-command.ts';",
          "import { parseMaestroProgram } from '../../../../src/compat/maestro/program-ir-parser.ts';",
        ].join('\n'),
      ],
      ['src/request/progress.ts', 'export function emitRequestProgress() {}'],
      [
        'packages/replay-port/src/daemon-port/native-command.ts',
        'export function runReplayCommand() {}',
      ],
      ['src/compat/maestro/program-ir-parser.ts', 'export function parseMaestroProgram() {}'],
    ]),
  );

  const violations = checkDaemonModularityRatchets(
    [...baselineEdges(), ...edges],
    REFERENCE,
    REFERENCE,
  );
  assert.deepEqual(
    violations.map(({ message }) => message.replace(/;.*/, '')),
    [
      'replay-test must not import src/request/progress.ts',
      'replay-test must not import packages/replay-port/src/daemon-port/native-command.ts',
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
    checkDaemonModularityRatchets([...baselineEdges(), ...edges], REFERENCE, REFERENCE),
    [],
  );
});

test('internal trees reject deep imports globally, including from daemon', () => {
  const edges = resolveImportEdges(
    new Map([
      [
        'packages/daemon/src/adapter.ts',
        "import type { Plan } from '@agent-device/maestro/internal/plan';",
      ],
      ['packages/maestro/src/internal/plan.ts', 'export type Plan = { steps: number };'],
    ]),
  );

  const violations = checkDaemonModularityRatchets(
    [...baselineEdges(), ...edges],
    REFERENCE,
    REFERENCE,
  );
  assert.equal(violations.length, 1);
  assert.match(violations[0]!.message, /must not import maestro's internal tree/);
});

test('replay-port rejects daemon source imports and engine back edges', () => {
  const edges = resolveImportEdges(
    new Map([
      [
        'packages/replay-port/src/daemon-port/test-command.ts',
        "import { handleSessionCloseCommands } from '../../../../packages/daemon/src/sessions/session-lifecycle/internal/session-close.ts';",
      ],
      [
        'packages/replay-port/src/daemon-port/native-command.ts',
        "import { SessionStore } from '../../../../packages/daemon/src/core/session-store.ts';",
      ],
      [
        'packages/ad-replay/src/internal/step-loop.ts',
        "import { runReplayCommand } from '../../../replay-port/src/daemon-port/native-command.ts';",
      ],
      [
        'packages/daemon/src/sessions/session-lifecycle/internal/session-close.ts',
        'export function handleSessionCloseCommands() {}',
      ],
      ['packages/daemon/src/core/session-store.ts', 'export class SessionStore {}'],
    ]),
  );

  const violations = checkDaemonModularityRatchets(
    [...baselineEdges(), ...edges],
    REFERENCE,
    REFERENCE,
  );
  assert.deepEqual(
    violations.map(({ file, message }) => ({ file, message: message.replace(/;.*/, '') })),
    [
      {
        file: 'packages/replay-port/src/daemon-port/test-command.ts',
        message:
          'replay-port must not import packages/daemon/src/sessions/session-lifecycle/internal/session-close.ts',
      },
      {
        file: 'packages/replay-port/src/daemon-port/native-command.ts',
        message: 'replay-port must not import packages/daemon/src/core/session-store.ts',
      },
      {
        file: 'packages/ad-replay/src/internal/step-loop.ts',
        message: 'ad-replay must not import packages/replay-port/src/daemon-port/native-command.ts',
      },
    ],
  );
});

test('session lifecycle rejects handler crossings and private helper imports', () => {
  const edges = resolveImportEdges(
    new Map([
      [
        'packages/daemon/src/sessions/handlers/session.ts',
        "import { prepareOpenSession } from '../session-lifecycle/internal/session-open-prepare.ts';\nexport function handleSessionCommands() {}",
      ],
      [
        'packages/daemon/src/sessions/session-lifecycle/internal/session-open-prepare.ts',
        "import { handleSessionCommands } from '../../handlers/session.ts';\nexport function prepareOpenSession() {}",
      ],
      [
        'packages/daemon/src/sessions/session-lifecycle/internal/session-close.ts',
        "import { handleSessionCommands } from '../../handlers/session.ts';",
      ],
    ]),
  );

  const violations = checkDaemonModularityRatchets(
    [...baselineEdges(), ...edges],
    REFERENCE,
    REFERENCE,
  );
  assert.deepEqual(
    violations.map(({ file, line, message }) => ({
      file,
      line,
      message: message.replace(/;.*/, ''),
    })),
    [
      {
        file: 'packages/daemon/src/sessions/handlers/session.ts',
        line: 1,
        message:
          "packages/daemon/src/sessions/handlers/session.ts must not import daemon-session-lifecycle's internal tree (packages/daemon/src/sessions/session-lifecycle/internal/session-open-prepare.ts)",
      },
      {
        file: 'packages/daemon/src/sessions/session-lifecycle/internal/session-open-prepare.ts',
        line: 1,
        message:
          'daemon-session-lifecycle must not import packages/daemon/src/sessions/handlers/session.ts',
      },
      {
        file: 'packages/daemon/src/sessions/session-lifecycle/internal/session-close.ts',
        line: 1,
        message:
          'daemon-session-lifecycle must not import packages/daemon/src/sessions/handlers/session.ts',
      },
    ],
  );
});

test('the handler shape rule catches a handlers folder under an unlisted layer', () => {
  // sessions/handlers/ and execution/handlers/ are what the fold produced; the rule must hold
  // for a handler folder planted under ANY layer, so a new one cannot slip past the policies.
  const edges = resolveImportEdges(
    new Map([
      [
        'packages/daemon/src/sessions/session-lifecycle/internal/session-open.ts',
        "import { handlePlantedCommands } from '../../../resources/handlers/planted.ts';",
      ],
      [
        'packages/daemon/src/resources/handlers/planted.ts',
        'export function handlePlantedCommands() {}',
      ],
      [
        'packages/daemon/src/sessions/session-lifecycle/internal/reads-support.ts',
        "import { sharedThing } from '../../../resources/support-thing.ts';",
      ],
      ['packages/daemon/src/resources/support-thing.ts', 'export function sharedThing() {}'],
    ]),
  );
  const violations = checkDaemonModularityRatchets(
    [...baselineEdges(), ...edges],
    REFERENCE,
    REFERENCE,
  );
  const handlerEdges = violations.filter(({ message }) =>
    message.includes('packages/daemon/src/resources/handlers/planted.ts'),
  );
  assert.equal(handlerEdges.length, 1);
  // The same import from a non-handlers folder under the same layer stays allowed.
  assert.ok(
    !violations.some(({ message }) => message.includes('resources/support-thing.ts')),
    'a non-handler resource folder must not become a forbidden target',
  );
});

test('interaction rejects handler crossings and deep imports around its facade', () => {
  const edges = resolveImportEdges(
    new Map([
      [
        'packages/daemon/src/execution/handlers/react-native.ts',
        "import { refSnapshotFlagGuardResponse } from '../interaction/internal/interaction-flags.ts';\nexport function handleReactNativeCommands() {}",
      ],
      [
        'packages/daemon/src/execution/interaction/internal/interaction-runtime.ts',
        "import { handleReactNativeCommands } from '../../handlers/react-native.ts';\nexport function createInteractionRuntime() {}",
      ],
      [
        'packages/daemon/src/execution/generic-settle.ts',
        "import { createInteractionRuntime } from './interaction/internal/interaction-runtime.ts';",
      ],
      [
        'packages/daemon/src/execution/selector-runtime.ts',
        "import { refSnapshotFlagGuardResponse } from './interaction/internal/interaction-flags.ts';",
      ],
      [
        'packages/daemon/src/execution/selector-runtime-backend.ts',
        "import { readTextForNode } from './interaction/internal/interaction-ref-policy.ts';",
      ],
      [
        'packages/daemon/src/execution/interaction/internal/interaction-flags.ts',
        'export function refSnapshotFlagGuardResponse() {}',
      ],
      [
        'packages/daemon/src/execution/interaction/internal/interaction-ref-policy.ts',
        'export function readTextForNode() {}',
      ],
    ]),
  );

  const violations = checkDaemonModularityRatchets(
    [...baselineEdges(), ...edges],
    REFERENCE,
    REFERENCE,
  );
  assert.equal(violations.length, 5);
  assert.ok(
    violations.some(({ message }) =>
      message.includes(
        "packages/daemon/src/execution/handlers/react-native.ts must not import daemon-interaction's internal tree",
      ),
    ),
  );
  assert.ok(
    violations.some(({ message }) =>
      message.includes(
        "packages/daemon/src/execution/interaction/internal/interaction-runtime.ts must not import packages/daemon/src/execution/handlers/react-native.ts from daemon-interaction's internal tree",
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

test('session observability rejects handler crossings and private helper imports', () => {
  const edges = resolveImportEdges(
    new Map([
      [
        'packages/daemon/src/sessions/handlers/session.ts',
        "import { handleAudioCommand } from '../session-observability/internal/session-audio.ts';\nexport function handleSessionCommands() {}",
      ],
      [
        'packages/daemon/src/sessions/session-observability/internal/session-audio.ts',
        "import { handleSessionCommands } from '../../handlers/session.ts';\nexport function handleAudioCommand() {}",
      ],
      [
        'packages/daemon/src/sessions/session-observability/internal/session-observability.ts',
        'export function handleSessionObservabilityCommands() {}',
      ],
    ]),
  );

  const violations = checkDaemonModularityRatchets(
    [...baselineEdges(), ...edges],
    REFERENCE,
    REFERENCE,
  );
  assert.deepEqual(
    violations.map(({ file, line, message }) => ({
      file,
      line,
      message: message.replace(/;.*/, ''),
    })),
    [
      {
        file: 'packages/daemon/src/sessions/handlers/session.ts',
        line: 1,
        message:
          "packages/daemon/src/sessions/handlers/session.ts must not import daemon-session-observability's internal tree (packages/daemon/src/sessions/session-observability/internal/session-audio.ts)",
      },
      {
        file: 'packages/daemon/src/sessions/session-observability/internal/session-audio.ts',
        line: 1,
        message:
          'daemon-session-observability must not import packages/daemon/src/sessions/handlers/session.ts',
      },
    ],
  );
});

test('snapshot execution cannot return to handler-owned support paths', () => {
  const restored = [
    'packages/daemon/src/handlers/snapshot-capture.ts',
    'packages/daemon/src/handlers/snapshot-interactor-capture.ts',
    'packages/daemon/src/handlers/snapshot-session.ts',
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
  assert.deepEqual(
    checkRetiredSnapshotExecutionPaths(['packages/daemon/src/sessions/handlers/snapshot.ts']),
    [],
  );
});

test('session lifecycle rejects restored neutral helper paths', () => {
  const violations = checkRetiredSessionLifecyclePaths([
    'packages/daemon/src/resources/session-device-resolution.ts',
    'packages/daemon/src/handlers/session-device-utils.ts',
    'packages/daemon/src/handlers/session-runtime-admission.ts',
    'packages/daemon/src/handlers/session-close-script.ts',
    'packages/daemon/src/handlers/session-close.ts',
  ]);

  assert.deepEqual(
    violations.map(({ message }) => message),
    [
      'retired session lifecycle path was restored: packages/daemon/src/handlers/session-device-utils.ts. Keep the neutral seam at its daemon owner instead of rebuilding a handler grab-bag.',
      'retired session lifecycle path was restored: packages/daemon/src/handlers/session-runtime-admission.ts. Keep the neutral seam at its daemon owner instead of rebuilding a handler grab-bag.',
      'retired session lifecycle path was restored: packages/daemon/src/handlers/session-close-script.ts. Keep the neutral seam at its daemon owner instead of rebuilding a handler grab-bag.',
      'retired session lifecycle path was restored: packages/daemon/src/handlers/session-close.ts. Keep the neutral seam at its daemon owner instead of rebuilding a handler grab-bag.',
    ],
  );
});

test('interaction rejects restored handler implementation paths', () => {
  const violations = checkRetiredInteractionPaths([
    'packages/daemon/src/execution/interaction/internal/interaction.ts',
    'packages/daemon/src/handlers/interaction-touch.ts',
  ]);

  assert.deepEqual(violations, [
    {
      rule: 'R10 daemon-modularity',
      file: 'packages/daemon/src/handlers/interaction-touch.ts',
      line: 1,
      message:
        'retired interaction handler path was restored: packages/daemon/src/handlers/interaction-touch.ts. Keep route implementations behind packages/daemon/src/execution/interaction/index.ts instead of rebuilding a handler-owned interaction surface.',
    },
  ]);
});

test('interaction rejects renamed handler implementation paths', () => {
  const violations = checkRetiredInteractionPaths([
    'packages/daemon/src/handlers/interaction-touch-v2.ts',
    'packages/daemon/src/handlers/find-next.ts',
  ]);

  assert.deepEqual(
    violations.map(({ file, message }) => ({ file, message })),
    [
      {
        file: 'packages/daemon/src/handlers/interaction-touch-v2.ts',
        message:
          'retired interaction handler path was restored: packages/daemon/src/handlers/interaction-touch-v2.ts. Keep route implementations behind packages/daemon/src/execution/interaction/index.ts instead of rebuilding a handler-owned interaction surface.',
      },
      {
        file: 'packages/daemon/src/handlers/find-next.ts',
        message:
          'retired interaction handler path was restored: packages/daemon/src/handlers/find-next.ts. Keep route implementations behind packages/daemon/src/execution/interaction/index.ts instead of rebuilding a handler-owned interaction surface.',
      },
    ],
  );
});

test('session lifecycle rejects any restored open or close handler path', () => {
  const violations = checkRetiredSessionLifecyclePaths([
    'packages/daemon/src/handlers/session-open-regressed.ts',
    'packages/daemon/src/handlers/session-close-regressed.ts',
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
        file: 'packages/daemon/src/handlers/session-open-regressed.ts',
        line: 1,
        message:
          'retired session lifecycle path was restored: packages/daemon/src/handlers/session-open-regressed.ts. Keep the neutral seam at its daemon owner instead of rebuilding a handler grab-bag.',
      },
      {
        rule: 'R10 daemon-modularity',
        file: 'packages/daemon/src/handlers/session-close-regressed.ts',
        line: 1,
        message:
          'retired session lifecycle path was restored: packages/daemon/src/handlers/session-close-regressed.ts. Keep the neutral seam at its daemon owner instead of rebuilding a handler grab-bag.',
      },
    ],
  );
});

test('session observability rejects restored handler paths', () => {
  const restoredPaths = [
    'packages/daemon/src/handlers/session-observability.ts',
    'packages/daemon/src/handlers/session-perf-runtime.ts',
    'packages/daemon/src/handlers/session-network.ts',
    'packages/daemon/src/handlers/session-audio.ts',
    'packages/daemon/src/handlers/session-network-regressed.ts',
    'packages/daemon/src/handlers/session-perf.ts',
    'packages/daemon/src/handlers/session-logs.ts',
    'packages/daemon/src/handlers/session-events.ts',
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

test('R9 holds each zone to the merge-base and keeps engine files outside the component', () => {
  // One commands file and one engine file traded for two provider-webdriver ones, so the
  // total stays at the merge-base's size and only the per-zone claims are on trial.
  const violations = checkDaemonModularityRatchets(
    baselineEdges(),
    measured({
      largestTypeCycle: typeCycleMembers({
        commands: 1,
        'ad-replay': 1,
        'provider-webdriver': 4,
      }),
    }),
    REFERENCE,
  );

  assert.equal(violations.length, 3);
  assert.ok(violations.some(({ message }) => /contains 1 commands file/.test(message)));
  assert.ok(violations.some(({ message }) => /contains 1 ad-replay file/.test(message)));
  assert.ok(violations.some(({ message }) => /engine file entered/.test(message)));
});

// #1837: the zone violation used to name the alphabetically-first zone member — a file that had
// been in the cycle all along — so the +1 was found only by diffing member lists between commits.
// The merge-base carries membership, so the message names exactly the files that joined.
test('R10 zone overflow names the member that joined the cycle', () => {
  // Sorts after the provider-webdriver probes: a first-member pick could not name it by luck.
  const joined = 'packages/daemon/src/core/snapshot-interactor-capture.ts';
  const members = [...typeCycleMembers({ 'provider-webdriver': 5 }), joined].sort();

  const violations = checkDaemonModularityRatchets(
    baselineEdges(),
    measured({ largestTypeCycle: members }),
    REFERENCE,
  );

  assert.equal(violations.length, 1);
  const [violation] = violations;
  assert.equal(violation!.rule, 'R10 daemon-modularity');
  assert.equal(violation!.file, 'scripts/layering/daemon-modularity.ts');
  assert.match(
    violation!.message,
    /contains 1 daemon-server file\(s\) \(baseline 0 at the merge-base\)/,
  );
  assert.match(
    violation!.message,
    new RegExp(`1 over the merge-base — the daemon-server file\\(s\\) that joined: ${joined}\\.`),
  );
});

test('R9 rejects a cycle grown past the merge-base', () => {
  const violations = checkDaemonModularityRatchets(
    baselineEdges(),
    measured({ largestTypeCycle: typeCycleMembers({ 'provider-webdriver': 7 }) }),
    REFERENCE,
  );

  assert.equal(violations.length, 2);
  assert.match(violations[0]!.rule, /^R9 /);
  assert.match(violations[0]!.message, /grew to 7 files \(baseline 6 at the merge-base\)/);
  assert.match(violations[1]!.rule, /^R10 /);
});

// The shrink direction used to need an edit in the same change, or the ceiling kept headroom the
// next change could spend. Measuring the merge-base banks it on merge, with nothing to lower.
test('R9 banks a shrink with no edit anywhere', () => {
  assert.deepEqual(
    checkDaemonModularityRatchets(
      baselineEdges(),
      measured({ largestTypeCycle: typeCycleMembers({ 'provider-webdriver': 5 }) }),
      REFERENCE,
    ),
    [],
  );
});

for (const file of [
  'src/cli.ts',
  'src/cli/commands/daemon.ts',
  'src/client/client-normalizers.ts',
  'packages/remote/src/daemon-artifacts.ts',
  'src/daemon-client/daemon-client.ts',
]) {
  for (const [kind, source] of [
    [
      'type-only',
      "import type { DaemonRequest } from '../packages/daemon/src/core/daemon-request.ts';",
    ],
    ['value', "import { handle } from '../packages/daemon/src/server/daemon-stop.ts';"],
    [
      'dynamic',
      "export const load = () => import('../packages/daemon/src/server/daemon-stop.ts');",
    ],
  ] as const) {
    test(`client-side ${file} importing the daemon package is red (${kind})`, () => {
      const edges = resolveImportEdges(
        new Map([
          [file, source.replaceAll('../', '../'.repeat(file.split('/').length - 1))],
          ['packages/daemon/src/core/daemon-request.ts', 'export type DaemonRequest = object;'],
          ['packages/daemon/src/server/daemon-stop.ts', 'export const handle = 1;'],
        ]),
      );

      const violations = checkDaemonModularityRatchets(edges, REFERENCE, REFERENCE);
      assert.equal(violations.length, 1);
      assert.match(violations[0]!.message, /client-side must not import packages\/daemon\/src/);
    });
  }
}

test('session command owners accept direct imports without an internal barrel', () => {
  const sources = new Map<string, string>();
  for (const [family, owner, symbol] of [
    ['session-lifecycle', 'session-close', 'handleSessionCloseCommands'],
    ['session-lifecycle', 'session-open', 'handleSessionOpenCommands'],
    ['session-lifecycle', 'inventory', 'handleSessionInventoryCommands'],
    ['session-observability', 'session-observability', 'handleSessionObservabilityCommands'],
  ]) {
    sources.set(
      `packages/daemon/src/sessions/${family}/internal/${owner}.ts`,
      `export function ${symbol}() {}`,
    );
    sources.set(
      `packages/daemon/src/sessions/handlers/${owner}.ts`,
      `import { ${symbol} } from '../${family}/internal/${owner}.ts';`,
    );
  }
  assert.deepEqual(
    checkDaemonModularityRatchets(resolveImportEdges(sources), REFERENCE, REFERENCE),
    [],
  );
});

test('session command families reject restored internal barrels', () => {
  const lifecycle = 'packages/daemon/src/sessions/session-lifecycle/index.ts';
  const observability = 'packages/daemon/src/sessions/session-observability/index.ts';
  assert.deepEqual(
    checkRetiredSessionLifecyclePaths([lifecycle]).map(({ file }) => file),
    [lifecycle],
  );
  assert.deepEqual(
    checkRetiredSessionObservabilityPaths([observability]).map(({ file }) => file),
    [observability],
  );
});
