import assert from 'node:assert/strict';
import { test } from 'node:test';
import { resolveImportEdges } from '../layering/model.ts';
import { buildGraph } from './model.ts';
import {
  computeCohesionSummary,
  computeDominatorSummary,
  computeZoneSccSummary,
} from './structure-summary.ts';

function sources(entries: Record<string, string>): Map<string, string> {
  return new Map(Object.entries(entries));
}

test('computeDominatorSummary excludes the dynamic-import seam and ranks bottlenecks by dominated subtree size', () => {
  const files = sources({
    'src/core/entry.ts': [
      "import { a } from './a.ts';",
      "import { b } from './b.ts';",
      "void import('./lazy.ts');",
    ].join('\n'),
    'src/core/a.ts': [
      "import { shared } from './shared.ts';",
      "import { onlyA } from './only-a.ts';",
    ].join('\n'),
    'src/core/b.ts': "import { shared } from './shared.ts';",
    'src/core/shared.ts': 'export const shared = 1;',
    'src/core/only-a.ts': 'export const onlyA = 1;',
    'src/core/lazy.ts': 'export const lazy = 1;',
  });
  const graph = buildGraph(files, resolveImportEdges(files));

  const summary = computeDominatorSummary('src/core/entry.ts', graph);

  // `lazy.ts` is reached only through a dynamic import, so it never joins the eager closure —
  // reachableFiles counts entry + a + b + shared + only-a, not the dynamically-loaded sixth file.
  assert.equal(summary.reachableFiles, 5);
  assert.equal(summary.totalFiles, 6);

  // `shared.ts` is reachable from both `a.ts` and `b.ts`, so its immediate dominator is `entry`,
  // not either importer — it dominates only itself, same as `b.ts` and `only-a.ts`. `a.ts` is the
  // only bottleneck that dominates more than its own file, because `only-a.ts` has no other path in.
  assert.deepEqual(
    summary.bottlenecks.map(({ file, files: fileCount }) => [file, fileCount]),
    [
      ['src/core/a.ts', 2],
      ['src/core/b.ts', 1],
      ['src/core/only-a.ts', 1],
      ['src/core/shared.ts', 1],
    ],
  );
});

test('computeDominatorSummary rejects an entry outside the layering graph', () => {
  const files = sources({ 'src/core/entry.ts': 'export const entry = 1;' });
  const graph = buildGraph(files, resolveImportEdges(files));

  assert.throws(
    () => computeDominatorSummary('src/core/missing.ts', graph),
    /src\/core\/missing\.ts is not a production source file/,
  );
});

test('computeZoneSccSummary finds a zone-level cycle built from value edges across distinct files', () => {
  // No single file pair cycles — R4 would reject that — but the zone pairs commands -> core ->
  // daemon-server -> commands close a loop because the last edge targets a different commands
  // file than the first edge's source.
  const files = sources({
    'src/commands/x1.ts': "import { y } from '../core/y.ts';",
    'src/core/y.ts': "import { z } from '../daemon/z.ts';",
    'src/daemon/z.ts': "import { x2 } from '../commands/x2.ts';",
    'src/commands/x2.ts': 'export const x2 = 1;',
  });
  const graph = buildGraph(files, resolveImportEdges(files));

  assert.deepEqual(computeZoneSccSummary(graph), {
    zones: 3,
    components: [{ zones: ['commands', 'core', 'daemon-server'], size: 3 }],
  });
});

test('computeZoneSccSummary reports no components over an acyclic zone graph', () => {
  const files = sources({
    'src/commands/a.ts': "import { b } from '../core/b.ts';",
    'src/core/b.ts': 'export const b = 1;',
  });
  const graph = buildGraph(files, resolveImportEdges(files));

  assert.deepEqual(computeZoneSccSummary(graph), { zones: 2, components: [] });
});

test('computeCohesionSummary reports full cohesion when declared zones match the detected communities', () => {
  const files = sources({
    'src/commands/a1.ts': ["import { a2 } from './a2.ts';", "import { a3 } from './a3.ts';"].join(
      '\n',
    ),
    'src/commands/a2.ts': "import { a3 } from './a3.ts';",
    'src/commands/a3.ts': 'export const a3 = 1;',
    'src/core/b1.ts': ["import { b2 } from './b2.ts';", "import { b3 } from './b3.ts';"].join('\n'),
    'src/core/b2.ts': "import { b3 } from './b3.ts';",
    'src/core/b3.ts': 'export const b3 = 1;',
  });
  const graph = buildGraph(files, resolveImportEdges(files));

  const summary = computeCohesionSummary(graph);

  assert.equal(summary.modularity.declaredZones, summary.modularity.detectedCommunities);
  assert.deepEqual(
    summary.zoneCohesion.map(({ zone, cohesionShare }) => [zone, cohesionShare]),
    [
      ['commands', 1],
      ['core', 1],
    ],
  );
});

test('computeCohesionSummary scores below the detected partition when declared zones split a cohesive cluster', () => {
  // Each zone holds one file from each of two otherwise-disjoint triangles, so neither zone
  // matches a detected community and the declared-zone partition scores worse than Louvain's.
  const files = sources({
    'src/commands/a1.ts': [
      "import { a2 } from '../core/a2.ts';",
      "import { a3 } from '../core/a3.ts';",
    ].join('\n'),
    'src/core/a2.ts': "import { a3 } from './a3.ts';",
    'src/core/a3.ts': 'export const a3 = 1;',
    'src/commands/b1.ts': [
      "import { b2 } from '../core/b2.ts';",
      "import { b3 } from '../core/b3.ts';",
    ].join('\n'),
    'src/core/b2.ts': "import { b3 } from './b3.ts';",
    'src/core/b3.ts': 'export const b3 = 1;',
  });
  const graph = buildGraph(files, resolveImportEdges(files));

  const summary = computeCohesionSummary(graph);

  assert.ok(summary.modularity.declaredZones < summary.modularity.detectedCommunities);
  assert.deepEqual(
    summary.zoneCohesion.map(({ zone, files: fileCount, largestCommunitySize }) => [
      zone,
      fileCount,
      largestCommunitySize,
    ]),
    [
      ['commands', 2, 1],
      ['core', 4, 2],
    ],
  );
});
