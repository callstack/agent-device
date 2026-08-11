import assert from 'node:assert/strict';
import { test } from 'node:test';
import { checkRuntimeCommandCutover } from './runtime-command-cutover-policy.ts';
import { MIGRATED_COMMAND_CUTOVERS } from './runtime-command-cutover-table.ts';
import { cutoverRowDefects, type MigratedCommandCutover } from './runtime-command-cutover-model.ts';
import { PLANTED_ROW, rowFor, sources, summariesFor } from './runtime-command-cutover-fixtures.ts';

// The mechanism itself (ADR 0019 §8): one planted row, one planted red. Per-row
// acceptance for the migrated commands lives in the table test.

const PLANTED_RULE = 'RPlanted planted-cutover';

test('the parametrized gate goes red on a planted row across every generalized column', () => {
  assert.deepEqual(
    summariesFor(
      PLANTED_RULE,
      [
        ['src/daemon/planted-legacy.ts', 'export const retired = true;'],
        [
          'src/daemon/planted-handler.ts',
          [
            "import { resolvePlantedBackend } from './planted-legacy.ts';",
            "requireCommandSupported('planted', device);",
            'const widened = runtime as PlantedRuntimeOperations;',
            "function handlePlantedCommand() { widened.operations['plantedDump']({}); }",
          ].join('\n'),
        ],
        [
          'src/core/command-descriptor/registry.ts',
          `const commands = [{ name: 'planted', capability: { apple: {} } }];`,
        ],
        ['src/core/capabilities.ts', `const WEB_QUERY_COMMANDS = ['find', 'planted'];`],
        [
          'src/platforms/apple/plugin.ts',
          `const supports = { [PUBLIC_COMMANDS.planted]: supportsDevice };
           const plugin = { planted: { resolveBackend() {} } } satisfies PlatformPlugin;`,
        ],
      ],
      [PLANTED_ROW],
    ),
    [
      'src/daemon/planted-legacy.ts: retired planted module remains',
      "src/daemon/planted-handler.ts: production source imports retired planted module './planted-legacy.ts'",
      'src/daemon/planted-handler.ts: legacy planted route resolvePlantedBackend',
      'src/daemon/planted-handler.ts: legacy planted capability admission requireCommandSupported',
      'src/daemon/planted-handler.ts: widened planted runtime type assertion',
      'src/daemon/planted-handler.ts: bracketed planted operation access',
      'src/core/command-descriptor/registry.ts: planted descriptor retains legacy capability admission',
      'src/core/capabilities.ts: static platform command set retains planted admission',
      'src/platforms/apple/plugin.ts: legacy PlatformPlugin planted facet',
      'src/platforms/apple/plugin.ts: Apple plugin retains legacy planted support or hint closure',
      // The bracketed access is still a call, so the operation count is satisfied while the
      // route is missing: the narrowing column and the singular-route column are independent.
      '(planted runtime): expected one handlePlantedCommand route, found 0',
    ],
  );
});

test('the planted row is green once the command has exactly one execution path', () => {
  assert.deepEqual(
    summariesFor(
      PLANTED_RULE,
      [
        [
          'src/daemon/planted-handler.ts',
          `
          // resolvePlantedBackend and requireCommandSupported('planted') were removed.
          const note = 'planted-legacy.ts';
          function handlePlantedCommand() {
            runtime.operations.plantedDump(input);
          }
          handlePlantedCommand(request);
        `,
        ],
      ],
      [PLANTED_ROW],
    ),
    [],
  );
});

test('rows are independent: one command going red leaves the others alone', () => {
  const violations = checkRuntimeCommandCutover(
    sources([['src/daemon/network-log.ts', 'export const parser = () => [];']]),
    MIGRATED_COMMAND_CUTOVERS.filter(
      ({ command }) => command === 'network' || command === 'record',
    ),
  );
  assert.deepEqual(
    violations
      .filter(({ rule }) => rule === 'R15 network-runtime-cutover')
      .map(({ message }) => message),
    [
      'retired network module remains',
      'expected one handleNetworkCommand route, found 0',
      'expected one narrowed networkDump call, found 0',
    ],
  );
  assert.deepEqual(
    violations
      .filter(({ rule }) => rule === 'R16 record-runtime-cutover')
      .map(({ message }) => message),
    [
      'expected one handleRecordTraceCommands route, found 0',
      'expected one narrowed screenRecordingStart call, found 0',
      'expected one narrowed screenRecordingReattach call, found 0',
      'expected one narrowed screenRecordingCleanup call, found 0',
    ],
  );
});

// ---------------------------------------------------------------------------
// A row cannot opt out of enforcement by leaving its claims unstated.
// ---------------------------------------------------------------------------

test('planted red: an incomplete row fails instead of enforcing nothing', () => {
  const incomplete = {
    rule: PLANTED_RULE,
    command: 'planted',
    subject: 'planted',
  } as unknown as MigratedCommandCutover;

  assert.deepEqual(
    summariesFor(PLANTED_RULE, [['src/daemon/anything.ts', 'export const x = 1;']], [incomplete]),
    [
      '(planted cutover row): cutover row declares no legacy retirement form',
      '(planted cutover row): cutover row declares no evidence tier',
      '(planted cutover row): cutover row declares no execution kind',
    ],
  );
});

test('planted red: a row that retires nothing is rejected', () => {
  assert.deepEqual(cutoverRowDefects({ ...PLANTED_ROW, legacyRetirement: {} }), [
    'declares no legacy retirement form',
  ]);
});

test('planted red: an empty singular-execution claim is rejected', () => {
  assert.deepEqual(
    cutoverRowDefects({
      ...PLANTED_ROW,
      singularExecution: { routes: [] as unknown as [string, ...string[]] },
    }),
    [
      'declares no singular daemon route',
      'names its operations but enforces none of them exactly once',
    ],
  );
});

test('planted red: a named-operation row that enforces no operation is rejected', () => {
  assert.deepEqual(
    cutoverRowDefects({
      ...PLANTED_ROW,
      singularExecution: {
        routes: ['handlePlantedCommand'],
      } as unknown as (typeof PLANTED_ROW)['singularExecution'],
    }),
    ['names its operations but enforces none of them exactly once'],
  );
});

test('planted red: a named-operation row that enforces only some operations is rejected', () => {
  assert.deepEqual(
    cutoverRowDefects({
      ...PLANTED_ROW,
      operations: { names: ['plantedDump', 'plantedReattach'] },
      singularExecution: {
        routes: ['handlePlantedCommand'],
        operations: ['plantedDump'],
        operationOwners: {
          plantedDump: ['handlePlantedCommand'],
          plantedReattach: ['handlePlantedCommand'],
        },
      },
    }),
    ['names operations it does not enforce exactly once: plantedReattach'],
  );
});

test('planted red: a row that enforces an operation it does not name is rejected', () => {
  assert.deepEqual(
    cutoverRowDefects({
      ...PLANTED_ROW,
      operations: { names: ['plantedDump'] },
      singularExecution: {
        routes: ['handlePlantedCommand'],
        operations: ['plantedDump', 'somebodyElsesOperation'],
        operationOwners: { plantedDump: ['handlePlantedCommand'] },
      },
    }),
    ['enforces operations it does not name: somebodyElsesOperation'],
  );
});

test('planted red: duplicate operations on either side are rejected', () => {
  assert.deepEqual(
    cutoverRowDefects({
      ...PLANTED_ROW,
      operations: { names: ['plantedDump', 'plantedDump'] },
      singularExecution: {
        routes: ['handlePlantedCommand'],
        operations: ['plantedDump', 'plantedDump'],
        operationOwners: { plantedDump: ['handlePlantedCommand'] },
      },
    }),
    ['names duplicate operations: plantedDump', 'enforces duplicate operations: plantedDump'],
  );
});

test('planted red: every named operation declares its lexical owner', () => {
  assert.deepEqual(
    cutoverRowDefects({
      ...PLANTED_ROW,
      singularExecution: {
        routes: ['handlePlantedCommand'],
        operations: ['plantedDump'],
        operationOwners: {},
      },
    }),
    ['names operations without lexical owners: plantedDump'],
  );
});

test('unrelated daemon calls neither satisfy nor duplicate an owner-scoped operation', () => {
  const missing = summariesFor(
    PLANTED_RULE,
    [
      [
        'src/daemon/planted-handler.ts',
        `
          function handlePlantedCommand() {}
          function handleUnrelatedCommand() { runtime.operations.plantedDump(input); }
          handlePlantedCommand(request);
        `,
      ],
    ],
    [PLANTED_ROW],
  );
  assert.deepEqual(missing, ['(planted runtime): expected one narrowed plantedDump call, found 0']);

  const present = summariesFor(
    PLANTED_RULE,
    [
      [
        'src/daemon/planted-handler.ts',
        `
          function handlePlantedCommand() { runtime.operations.plantedDump(input); }
          function handleUnrelatedCommand() { runtime.operations.plantedDump(input); }
          handlePlantedCommand(request);
        `,
      ],
    ],
    [PLANTED_ROW],
  );
  assert.deepEqual(present, []);
});

test('a pattern-only row may prove singularity through its route alone', () => {
  assert.deepEqual(cutoverRowDefects(rowFor('logs')), []);
});

test('planted red: a durable row without a lifecycle proof is rejected', () => {
  assert.deepEqual(cutoverRowDefects({ ...PLANTED_ROW, tier: 'durable-resource' }), [
    'is durable-resource tier but declares no lifecycle proof',
  ]);
});

test('planted red: a request-scoped row claiming durable machinery is rejected', () => {
  assert.deepEqual(cutoverRowDefects({ ...PLANTED_ROW, lifecycleProof: () => [] }), [
    'is request-scoped tier but declares a durable lifecycle proof',
  ]);
});

test('every shipped row states its claims', () => {
  assert.deepEqual(
    MIGRATED_COMMAND_CUTOVERS.flatMap((row) =>
      cutoverRowDefects(row).map((defect) => `${row.command}: ${defect}`),
    ),
    [],
  );
});
