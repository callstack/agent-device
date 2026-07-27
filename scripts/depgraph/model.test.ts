import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { listSourceFiles, TYPE_INVERSION_BASELINE } from '../layering/check.ts';
import { resolveImportEdges } from '../layering/model.ts';
import {
  buildGraph,
  collapseEdges,
  collectCycles,
  markRedundantEdges,
  typeInversionsByPair,
} from './model.ts';

function sources(entries: Record<string, string>): Map<string, string> {
  return new Map(Object.entries(entries));
}

test('collapseEdges keeps one edge per pair at the strongest kind', () => {
  const edges = resolveImportEdges(
    sources({
      'src/core/a.ts': [
        "import type { Shape } from './b.ts';",
        "import { run } from './b.ts';",
        "import type { Other } from './c.ts';",
        "void import('./d.ts');",
      ].join('\n'),
      'src/core/b.ts': 'export const run = 1;',
      'src/core/c.ts': 'export type Other = string;',
      'src/core/d.ts': 'export const lazy = 1;',
    }),
  );

  assert.deepEqual(
    collapseEdges(edges).map((edge) => ({ to: edge.to, kind: edge.kind })),
    [
      { to: 'src/core/b.ts', kind: 'value' },
      { to: 'src/core/c.ts', kind: 'type' },
      { to: 'src/core/d.ts', kind: 'dynamic' },
    ],
  );
});

test('redundant marks only value edges whose target is already reachable at distance >= 2', () => {
  const edges = collapseEdges(
    resolveImportEdges(
      sources({
        // a -> b -> c makes the direct a -> c edge removable; a -> d is the only route to d.
        'src/core/a.ts': [
          "import { b } from './b.ts';",
          "import { c } from './c.ts';",
          "import { d } from './d.ts';",
        ].join('\n'),
        'src/core/b.ts': "export { c as b } from './c.ts';",
        'src/core/c.ts': 'export const c = 1;',
        'src/core/d.ts': 'export const d = 1;',
      }),
    ),
  );
  markRedundantEdges(edges);

  const flagged = edges
    .filter((edge) => edge.redundant)
    .map((edge) => `${edge.from} -> ${edge.to}`);
  assert.deepEqual(flagged, ['src/core/a.ts -> src/core/c.ts']);
});

test('a type-only shortcut is never treated as redundant against a value path', () => {
  const edges = collapseEdges(
    resolveImportEdges(
      sources({
        'src/core/a.ts': ["import { b } from './b.ts';", "import type { C } from './c.ts';"].join(
          '\n',
        ),
        'src/core/b.ts': "export { c as b } from './c.ts';",
        'src/core/c.ts': 'export type C = string;\nexport const c = 1;',
      }),
    ),
  );
  markRedundantEdges(edges);

  assert.deepEqual(
    edges.filter((edge) => edge.redundant),
    [],
  );
});

test('collectCycles separates gate-rejected value cycles from type-only and dynamic loops', () => {
  const valueCycle = collectCycles(
    resolveImportEdges(
      sources({
        'src/core/a.ts': "import { b } from './b.ts';\nexport const a = 1;",
        'src/core/b.ts': "import { a } from './a.ts';\nexport const b = 1;",
      }),
    ),
  );
  assert.deepEqual(
    valueCycle.map((cycle) => cycle.kind),
    ['value'],
  );

  const typeCycle = collectCycles(
    resolveImportEdges(
      sources({
        'src/core/a.ts': "import type { B } from './b.ts';\nexport type A = B;",
        'src/core/b.ts': "import type { A } from './a.ts';\nexport type B = A | null;",
      }),
    ),
  );
  assert.deepEqual(
    typeCycle.map((cycle) => cycle.kind),
    ['type'],
  );

  const dynamicCycle = collectCycles(
    resolveImportEdges(
      sources({
        'src/core/a.ts': "export const a = () => import('./b.ts');",
        'src/core/b.ts': "export const b = () => import('./a.ts');",
      }),
    ),
  );
  assert.deepEqual(
    dynamicCycle.map((cycle) => cycle.kind),
    ['dynamic'],
  );
});

test('buildGraph reports zone membership, degrees, and cross-zone edge counts', () => {
  const files = sources({
    'src/kernel/errors.ts': 'export const fail = 1;\n',
    'src/core/interactors/tap.ts': "import { fail } from '../../kernel/errors.ts';\n",
    'src/commands/tap.ts': [
      "import { fail } from '../kernel/errors.ts';",
      "import '../core/interactors/tap.ts';",
    ].join('\n'),
  });
  const graph = buildGraph(files, resolveImportEdges(files));

  const kernel = graph.nodes.find((node) => node.id === 'src/kernel/errors.ts')!;
  assert.equal(kernel.zone, 'kernel');
  assert.equal(kernel.fanIn, 2);
  assert.equal(kernel.fanOut, 0);

  // A non-root zone member resolves to its folder, not to `(root)`.
  const interactor = graph.nodes.find((node) => node.id === 'src/core/interactors/tap.ts')!;
  assert.equal(interactor.zone, 'core');

  assert.deepEqual(
    graph.zoneEdges.map((edge) => `${edge.from} -> ${edge.to} (${edge.count})`),
    ['commands -> core (1)', 'commands -> kernel (1)', 'core -> kernel (1)'],
  );
  assert.deepEqual(
    graph.zones.map((zone) => zone.classification),
    ['ranked', 'ranked', 'ranked'],
  );
});

// Two-sources-of-truth check, run by the Layering Guard job.
//
// The report and the gate read the same model, so their inversion counts must agree. This locks
// that: if the tree changes and only one side is updated, or if the report's extraction diverges
// from what the gate sees, this fails and names the difference.
//
// What it proves precisely: the report's own graph build, over the real tree, reproduces
// TYPE_INVERSION_BASELINE. It is a cross-check of the extraction and the baseline against reality,
// not two independent algorithms — `typeInversionsByPair` deliberately applies the gate's counting
// rule so the numbers cannot differ for a reason unrelated to layering. The gate stays the
// authority; if these disagree, the baseline or the tree is wrong, never this test.
test("the report's inversion count reproduces the gate's TYPE_INVERSION_BASELINE", () => {
  const files = listSourceFiles();
  const sources = new Map(files.map((file) => [file, readFileSync(file, 'utf8')]));
  const actual = typeInversionsByPair(resolveImportEdges(sources));

  assert.deepEqual(
    actual,
    // Object key order differs between the two literals; compare as sorted entries.
    Object.fromEntries(
      Object.entries(TYPE_INVERSION_BASELINE).sort(([left], [right]) => left.localeCompare(right)),
    ),
    'depgraph and scripts/layering/check.ts disagree about type-only spine inversions. ' +
      'Regenerate with `pnpm depgraph` and update TYPE_INVERSION_BASELINE, or fix the edge.',
  );
});
