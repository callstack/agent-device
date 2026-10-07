import assert from 'node:assert/strict';
import { test } from 'node:test';
import { resolveImportEdges } from '../layering/model.ts';
import { EXECUTABLE_EDGES, importEdgeId, importGraph, VALUE_EDGES } from './import-graph.ts';
import { collapseEdges } from './model.ts';

const edges = collapseEdges(
  resolveImportEdges(
    new Map(
      Object.entries({
        'src/core/a.ts': [
          "import { b } from './b.ts';",
          "import type { C } from './c.ts';",
          "void import('./d.ts');",
        ].join('\n'),
        'src/core/b.ts': 'export const b = 1;',
        'src/core/c.ts': 'export type C = string;',
        'src/core/d.ts': 'export const d = 1;',
      }),
    ),
  ),
);

test('importGraph keeps only the requested edge kinds, keyed by file pair', () => {
  assert.deepEqual(
    importGraph(edges, VALUE_EDGES).edges.map((edge) => edge.id),
    [importEdgeId('src/core/a.ts', 'src/core/b.ts')],
  );
  assert.deepEqual(
    importGraph(edges, EXECUTABLE_EDGES).edges.map((edge) => edge.id),
    [
      importEdgeId('src/core/a.ts', 'src/core/b.ts'),
      importEdgeId('src/core/a.ts', 'src/core/d.ts'),
    ],
  );
});

test('importGraph adds explicit files that no kept edge touches', () => {
  assert.deepEqual(
    importGraph(edges, VALUE_EDGES, ['src/core/c.ts'])
      .nodes.map((node) => node.id)
      .sort(),
    ['src/core/a.ts', 'src/core/b.ts', 'src/core/c.ts'],
  );
});

test('importGraph gives every distinct file pair its own edge id', () => {
  const pair = (from: string, to: string) => ({ ...edges[0]!, from, to });
  const graph = importGraph(
    [pair('src/a -> b.ts', 'src/c.ts'), pair('src/a', 'b.ts -> src/c.ts')],
    VALUE_EDGES,
  );

  assert.equal(new Set(graph.edges.map((edge) => edge.id)).size, 2);
});
