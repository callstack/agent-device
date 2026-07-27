import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { listSourceFiles, TYPE_INVERSION_BASELINE } from '../layering/check.ts';
import { resolveImportEdges } from '../layering/model.ts';
import {
  buildGraph,
  collapseEdges,
  collectCycles,
  markTransitivelyReachableEdges,
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

test('flags only value edges whose target is already reachable at distance >= 2', () => {
  const edges = collapseEdges(
    resolveImportEdges(
      sources({
        // a -> b -> c means c is reachable from a at distance 2, so the direct a -> c edge is
        // FLAGGED. Note it is not removable: `b` re-exports c's binding under a different name,
        // so deleting a -> c would break a's `c` import. That gap is the point of the rename —
        // this measures module reachability, not safe removal. a -> d is the only route to d.
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
  markTransitivelyReachableEdges(edges);

  const flagged = edges
    .filter((edge) => edge.transitivelyReachable)
    .map((edge) => `${edge.from} -> ${edge.to}`);
  assert.deepEqual(flagged, ['src/core/a.ts -> src/core/c.ts']);
});

test('a type-only shortcut is never flagged against a value path', () => {
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
  markTransitivelyReachableEdges(edges);

  assert.deepEqual(
    edges.filter((edge) => edge.transitivelyReachable),
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

// A raw NUL byte in a source file makes Git classify it as binary, which hides the whole diff
// behind `- -` and leaves the file unreviewable. This module used a literal NUL as a map-key
// delimiter and shipped that way through a review; it is now the escape sequence, identical at
// runtime and textual on disk. Guarded repo-wide rather than for this one file, because nothing
// else would catch a recurrence and the failure mode is silent: the code works, the review does not.
test('no tracked TypeScript source contains a raw NUL byte', () => {
  const tracked = execFileSync('git', ['ls-files', 'src/*.ts', 'src/**/*.ts', 'scripts/**/*.ts'], {
    encoding: 'utf8',
  })
    .split('\n')
    .filter(Boolean);

  const binary = tracked.filter((file) => readFileSync(file).includes(0));
  assert.deepEqual(
    binary,
    [],
    'these files contain a raw NUL byte, so Git treats them as binary and hides their diff. ' +
      'Use a unicode escape instead of a literal control character.',
  );
});

// build.ts had no coverage at all: every test above exercises model.ts, so the CLI could break its
// output path, JSON shape or summary without anything failing. These run it as a subprocess, which
// is the only way to cover argument handling and the file it actually writes.

function runBuild(args: readonly string[]): { status: number | null; stdout: string; stderr: string } {
  const result = spawnSync(
    process.execPath,
    ['--experimental-strip-types', 'scripts/depgraph/build.ts', ...args],
    { encoding: 'utf8' },
  );
  return { status: result.status, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
}

test('build.ts writes the default path and a summary consistent with the JSON', () => {
  const { status, stdout } = runBuild([]);
  assert.equal(status, 0, stdout);

  const payload = JSON.parse(readFileSync('.tmp/depgraph/graph.json', 'utf8')) as {
    generated: { commit: string; files: number; edges: number };
    zones: { id: string; rank: number | null }[];
    nodes: unknown[];
    edges: [number, number, number, number][];
    typeInversions: Record<string, number>;
  };

  // Wire shape: the fields a consumer queries. A rename here is a breaking change for any script
  // following README.md, so it is pinned rather than assumed.
  assert.equal(payload.nodes.length, payload.generated.files);
  assert.equal(payload.edges.length, payload.generated.edges);
  assert.ok(payload.zones.length > 0);
  assert.ok(Object.keys(payload.typeInversions).length > 0);

  // The printed summary must agree with the payload it was derived from.
  const inversions = Object.values(payload.typeInversions).reduce((sum, n) => sum + n, 0);
  assert.match(stdout, new RegExp(`${payload.generated.files} files, ${payload.generated.edges} edges`));
  assert.match(stdout, new RegExp(`type-only spine inversions \\(R6\\): ${inversions}`));
  const reachable = payload.edges.filter(([, , , flags]) => (flags & 2) !== 0).length;
  assert.match(stdout, new RegExp(`reachable at distance >= 2: ${reachable}`));
});

test('build.ts honours --out and reports the path it wrote', () => {
  const out = join(mkdtempSync(join(tmpdir(), 'depgraph-')), 'custom.json');
  const { status, stdout } = runBuild(['--out', out]);
  assert.equal(status, 0, stdout);
  assert.ok(existsSync(out), `expected ${out} to exist`);
  JSON.parse(readFileSync(out, 'utf8'));
  assert.ok(stdout.includes('custom.json'), stdout);
});

test('build.ts falls back to the default path when --out has no value', () => {
  // Not an error path today: a trailing `--out` is ignored rather than rejected. Pinned so the
  // behaviour is a decision rather than an accident, and so changing it is a visible diff.
  const { status, stdout } = runBuild(['--out']);
  assert.equal(status, 0, stdout);
  assert.ok(stdout.includes('.tmp/depgraph/graph.json'), stdout);
});
