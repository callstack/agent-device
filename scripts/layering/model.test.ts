import assert from 'node:assert/strict';
import { test } from 'node:test';
import { listSourceFiles } from './check.ts';
import {
  compareBackEdgeBaseline,
  collectBackEdges,
  findBaselineRaises,
  findValueImportCycles,
  parseImports,
  resolveImportEdges,
} from './model.ts';

test('parseImports distinguishes value, type-only, dynamic, and value re-export edges', () => {
  const edges = parseImports(
    [
      "import value from './value.ts';",
      "import type { TypeA } from './types.ts';",
      "import { type TypeB, type TypeC } from './more-types.ts';",
      "import { type TypeD, runtime } from './mixed.ts';",
      "export { runtimeExport } from './exported.ts';",
      "export type { ExportedType } from './exported-types.ts';",
      "void import('./dynamic.ts');",
    ].join('\n'),
  );

  assert.deepEqual(
    edges.map(({ spec, dynamic, typeOnly }) => ({ spec, dynamic, typeOnly })),
    [
      { spec: './value.ts', dynamic: false, typeOnly: false },
      { spec: './types.ts', dynamic: false, typeOnly: true },
      { spec: './more-types.ts', dynamic: false, typeOnly: true },
      { spec: './mixed.ts', dynamic: false, typeOnly: false },
      { spec: './exported.ts', dynamic: false, typeOnly: false },
      { spec: './exported-types.ts', dynamic: false, typeOnly: true },
      { spec: './dynamic.ts', dynamic: true, typeOnly: false },
    ],
  );
});

test('value cycles fail while type-only and dynamic cycles stay outside the graph', () => {
  const valueCycle = resolveImportEdges(
    new Map([
      ['src/core/a.ts', "import '../commands/b.ts';"],
      ['src/commands/b.ts', "export { a } from '../core/a.ts';"],
    ]),
  );
  assert.deepEqual(findValueImportCycles(valueCycle), [
    ['src/commands/b.ts', 'src/core/a.ts', 'src/commands/b.ts'],
  ]);

  const nonValueCycle = resolveImportEdges(
    new Map([
      ['src/core/a.ts', "import type { B } from '../commands/b.ts';"],
      ['src/commands/b.ts', "void import('../core/a.ts');"],
    ]),
  );
  assert.deepEqual(findValueImportCycles(nonValueCycle), []);
});

test('back-edge counts follow the documented target spine and drift in either direction', () => {
  const edges = resolveImportEdges(
    new Map([
      ['src/platforms/apple.ts', "import '../core/platform-plugin.ts';"],
      ['src/core/platform-plugin.ts', 'export const plugin = true;'],
      ['src/commands/help.ts', "import '../cli/parser.ts';"],
      ['src/cli/parser.ts', 'export const parser = true;'],
      ['src/utils/shared.ts', "import '../core/platform-plugin.ts';"],
    ]),
  );
  const actual = collectBackEdges(edges);
  assert.deepEqual(actual, {
    'commands -> cli': ['src/commands/help.ts -> src/cli/parser.ts'],
    'platforms -> core': ['src/platforms/apple.ts -> src/core/platform-plugin.ts'],
  });
  assert.deepEqual(
    compareBackEdgeBaseline(
      { 'commands -> cli': ['src/commands/help.ts -> src/cli/parser.ts'] },
      actual,
    ),
    [
      {
        pair: 'platforms -> core',
        added: ['src/platforms/apple.ts -> src/core/platform-plugin.ts'],
        removed: [],
      },
    ],
  );
  assert.deepEqual(
    compareBackEdgeBaseline(
      {
        ...actual,
        'commands -> client': ['src/commands/help.ts -> src/client/client.ts'],
      },
      actual,
    ),
    [
      {
        pair: 'commands -> client',
        added: [],
        removed: ['src/commands/help.ts -> src/client/client.ts'],
      },
    ],
  );
});

test('exact back-edge identities reject same-count replacements', () => {
  const baseline = {
    'commands -> cli': ['src/commands/a.ts -> src/cli/a.ts'],
  };
  const actual = {
    'commands -> cli': ['src/commands/b.ts -> src/cli/b.ts'],
  };
  assert.deepEqual(compareBackEdgeBaseline(baseline, actual), [
    {
      pair: 'commands -> cli',
      added: ['src/commands/b.ts -> src/cli/b.ts'],
      removed: ['src/commands/a.ts -> src/cli/a.ts'],
    },
  ]);
});

test('findBaselineRaises rejects additions and replacements but permits removal', () => {
  const base = {
    'platforms -> core': ['src/platforms/a.ts -> src/core/a.ts'],
    'commands -> cli': ['src/commands/a.ts -> src/cli/a.ts'],
  };
  assert.deepEqual(
    findBaselineRaises(base, {
      'platforms -> core': [
        'src/platforms/a.ts -> src/core/a.ts',
        'src/platforms/b.ts -> src/core/b.ts',
      ],
      'commands -> cli': ['src/commands/b.ts -> src/cli/b.ts'],
      'commands -> client': ['src/commands/c.ts -> src/client/c.ts'],
    }),
    [
      {
        pair: 'commands -> cli',
        added: ['src/commands/b.ts -> src/cli/b.ts'],
      },
      {
        pair: 'commands -> client',
        added: ['src/commands/c.ts -> src/client/c.ts'],
      },
      {
        pair: 'platforms -> core',
        added: ['src/platforms/b.ts -> src/core/b.ts'],
      },
    ],
  );
  assert.deepEqual(findBaselineRaises(base, base), []);
  assert.deepEqual(
    findBaselineRaises(base, {
      'platforms -> core': [],
      'commands -> cli': ['src/commands/a.ts -> src/cli/a.ts'],
    }),
    [],
  );
});

test('listSourceFiles includes root-level src/*.ts production files', () => {
  const files = new Set(listSourceFiles());
  for (const rootFile of ['src/cli.ts', 'src/command-catalog.ts', 'src/backend.ts']) {
    assert.ok(files.has(rootFile), `expected ${rootFile} in analyzed source files`);
  }
  assert.ok(![...files].some((file) => file.endsWith('.test.ts')));
});
