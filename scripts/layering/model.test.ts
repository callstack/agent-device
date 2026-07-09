import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  compareBackEdgeBaseline,
  countBackEdges,
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
  const actual = countBackEdges(edges);
  assert.deepEqual(actual, {
    'commands -> cli': 1,
    'platforms -> core': 1,
  });
  assert.deepEqual(compareBackEdgeBaseline({ 'commands -> cli': 1 }, actual), [
    { pair: 'platforms -> core', baseline: 0, actual: 1 },
  ]);
  assert.deepEqual(compareBackEdgeBaseline({ ...actual, 'commands -> client': 1 }, actual), [
    { pair: 'commands -> client', baseline: 1, actual: 0 },
  ]);
});
