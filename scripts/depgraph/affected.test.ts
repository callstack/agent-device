import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { selectChecks } from '../check-affected/model.ts';
import { resolveImportEdges } from '../layering/model.ts';
import {
  bound,
  collectDependents,
  commandsReaching,
  formatBounded,
  guaranteeRowsForFile,
  rankByFanIn,
  weakDirectDependents,
  zoneBreakdown,
} from './affected.ts';
import {
  computeBlastRadius,
  formatBlastRadius,
  guaranteeRows,
  parseInvocation,
  parseRouteEntries,
} from './affected-run.ts';
import { collapseEdges, type GraphNode } from './model.ts';

const repoRoot = execFileSync('git', ['rev-parse', '--show-toplevel'], {
  encoding: 'utf8',
}).trim();

function edgesOf(entries: Record<string, string>) {
  return collapseEdges(resolveImportEdges(new Map(Object.entries(entries))));
}

function nodesOf(entries: Record<string, Partial<GraphNode>>): Map<string, GraphNode> {
  return new Map(
    Object.entries(entries).map(([id, node]) => [
      id,
      { id, zone: 'core', loc: 1, fanIn: 0, fanOut: 0, cycle: -1, ...node },
    ]),
  );
}

test('collectDependents separates direct importers from transitive ones', () => {
  const edges = edgesOf({
    'src/core/target.ts': 'export const t = 1;',
    'src/core/direct.ts': "export { t } from './target.ts';",
    'src/core/far.ts': "import { t } from './direct.ts';\nexport const f = t;",
    'src/core/unrelated.ts': 'export const u = 1;',
  });

  assert.deepEqual(collectDependents('src/core/target.ts', edges), {
    direct: ['src/core/direct.ts'],
    all: ['src/core/direct.ts', 'src/core/far.ts'],
    transitiveOnly: ['src/core/far.ts'],
  });
});

test('collectDependents ignores type-only and dynamic dependents, which are counted separately', () => {
  const edges = edgesOf({
    'src/core/target.ts': 'export type T = string;\nexport const t = 1;',
    'src/core/typed.ts': "import type { T } from './target.ts';\nexport type U = T;",
    'src/core/lazy.ts': "export const load = () => import('./target.ts');",
  });

  assert.deepEqual(collectDependents('src/core/target.ts', edges).all, []);
  assert.deepEqual(weakDirectDependents('src/core/target.ts', edges), { type: 1, dynamic: 1 });
});

test('zoneBreakdown and rankByFanIn order by weight, then name', () => {
  const nodes = nodesOf({
    'src/daemon/a.ts': { zone: 'daemon-server', fanIn: 3 },
    'src/daemon/b.ts': { zone: 'daemon-server', fanIn: 9 },
    'src/core/c.ts': { zone: 'core', fanIn: 9 },
  });
  const files = ['src/daemon/a.ts', 'src/daemon/b.ts', 'src/core/c.ts'];

  assert.deepEqual(zoneBreakdown(files, nodes), [
    { zone: 'daemon-server', count: 2 },
    { zone: 'core', count: 1 },
  ]);
  assert.deepEqual(
    rankByFanIn(files, nodes).map((entry) => entry.file),
    ['src/core/c.ts', 'src/daemon/b.ts', 'src/daemon/a.ts'],
  );
});

test('commandsReaching follows the dynamic import a route uses to load its handler', () => {
  const edges = edgesOf({
    'src/daemon/handlers/session.ts':
      "import { helper } from '../../utils/helper.ts';\nexport const h = helper;",
    'src/daemon/interaction/index.ts': 'export const f = 1;',
    'src/utils/helper.ts': 'export const helper = 1;',
    'src/daemon/chain.ts': [
      "export const routes = { session: () => import('./handlers/session.ts'),",
      "  find: () => import('./interaction/index.ts') };",
    ].join('\n'),
  });
  const chains = [
    { command: 'open', route: 'session', entry: 'src/daemon/handlers/session.ts' },
    { command: 'find', route: 'find', entry: 'src/daemon/interaction/index.ts' },
  ];

  assert.deepEqual(
    commandsReaching('src/utils/helper.ts', chains, edges).map((chain) => chain.command),
    ['open'],
  );
  // The entry module itself counts as part of its own chain.
  assert.deepEqual(
    commandsReaching('src/daemon/interaction/index.ts', chains, edges).map(
      (chain) => chain.command,
    ),
    ['find'],
  );
});

test('guaranteeRowsForFile matches module-qualified cells only, on the whole path', () => {
  const rows = [
    {
      path: 'runtime-selector',
      guarantee: 'disambiguation',
      kind: 'runtime',
      via: 'packages/selectors/src/internal/resolve.ts#resolveSelectorChain',
    },
    {
      path: 'runtime-ref',
      guarantee: 'occlusion',
      kind: 'runtime',
      via: 'packages/selectors/src/internal/resolve-extra.ts#other',
    },
    {
      path: 'native-ref',
      guarantee: 'errorTaxonomy',
      kind: 'delegated',
      via: 'runner errors fall back to tree resolution',
    },
  ];

  assert.deepEqual(
    guaranteeRowsForFile('packages/selectors/src/internal/resolve.ts', rows).map(
      (row) => row.guarantee,
    ),
    ['disambiguation'],
  );
});

test('bounded lists disclose what they hid', () => {
  assert.deepEqual(bound([1, 2, 3, 4], 2), { shown: [1, 2], hidden: 2 });
  assert.equal(formatBounded(bound([1, 2, 3, 4], 2), String), '1, 2 (+2 more)');
  assert.equal(formatBounded(bound([1, 2], 5), String), '1, 2');
  assert.equal(formatBounded(bound([], 5), String), '(none)');
});

test('every daemon route in the real route table resolves to a handler entry', () => {
  const chainFile = 'src/daemon/request-handler-chain.ts';
  const source = readFileSync(path.join(repoRoot, chainFile), 'utf8');
  const entries = parseRouteEntries(source, chainFile);
  const declared = [...source.matchAll(/(\w+): defineDaemonRoute\(/g)].map((match) => match[1]!);

  assert.ok(declared.length > 0, 'route table shape changed: no defineDaemonRoute entries found');
  assert.deepEqual([...entries.keys()].sort(), [...declared].sort());
  assert.equal(entries.get('generic'), 'src/daemon/request-generic-dispatch.ts');
});

test('the real guarantee matrix contributes module-qualified rows', () => {
  const rows = guaranteeRows();
  assert.ok(rows.length > 0);
  assert.ok(
    rows.some((row) => row.via.startsWith('src/') && row.via.includes('#')),
    'expected at least one runtime cell naming a module',
  );
});

test('a flag keeps its value whichever side of the path it is on', () => {
  const expected = { file: 'src/utils/exec.ts', json: true, limit: 25 };
  assert.deepEqual(parseInvocation(['src/utils/exec.ts', '--json', '--limit', '25']), expected);
  assert.deepEqual(parseInvocation(['--json', '--limit', '25', 'src/utils/exec.ts']), expected);
  assert.deepEqual(parseInvocation(['src/utils/exec.ts', '--json', '--limit=25']), expected);
  assert.deepEqual(parseInvocation(['src/utils/exec.ts']), {
    file: 'src/utils/exec.ts',
    json: false,
    limit: 10,
  });
  assert.deepEqual(parseInvocation(['--help']), { help: true });
});

test('parseInvocation rejects a missing path, a second path, and a non-positive limit', () => {
  assert.throws(() => parseInvocation(['--json']), /missing <path>/);
  assert.throws(() => parseInvocation(['a.ts', 'b.ts']), /expected one <path>, got 2: a\.ts b\.ts/);
  assert.throws(() => parseInvocation(['a.ts', '--limit', '0']), /positive integer/);
  assert.throws(() => parseInvocation(['a.ts', '--limit', 'lots']), /positive integer/);
});

test('text output bounds every list and says what it hid', () => {
  const text = formatBlastRadius(
    {
      file: 'src/utils/exec.ts',
      zone: 'utils',
      fanIn: 81,
      fanOut: 3,
      dependents: {
        direct: ['src/a.ts', 'src/b.ts', 'src/c.ts'],
        transitive: ['src/d.ts'],
        byZone: [{ zone: 'utils', count: 4 }],
        topByFanIn: [{ file: 'src/a.ts', fanIn: 7 }],
        weakDirect: { type: 2, dynamic: 1 },
      },
      gates: { checks: ['lint', 'typecheck'], failOpen: false },
      commands: [{ command: 'click', route: 'interaction', entry: 'src/daemon/handlers/x.ts' }],
      liveOwners: { manifest: 'test/…/coverage-manifest.ts', present: false, owners: [] },
      guaranteeRows: [],
    },
    2,
  );

  assert.match(text, /3 direct, 1 transitive .*2 type-only and 1 dynamic/);
  assert.match(text, /direct: {2}src\/a\.ts, src\/b\.ts \(\+1 more\)/);
  assert.match(text, /gates for this set: lint, typecheck/);
  assert.match(text, /is not in this tree/);
});

test('blast radius over the real tree agrees with check:affected and stays under 10s', async () => {
  const file = 'packages/host-kit/src/internal/exec.ts';
  const started = Date.now();
  const radius = await computeBlastRadius(repoRoot, file);
  const elapsed = Date.now() - started;

  assert.ok(elapsed < 10_000, `blast radius took ${elapsed}ms`);
  assert.ok(radius.dependents.direct.length > 0);

  // The gate plan is check:affected's own selection over the dependent set, so it can only ever
  // be a superset of the plan for the file alone — a contradiction would mean an edit selected
  // fewer gates the more files it touched.
  const single = selectChecks({ changedFiles: [file] });
  for (const check of single.checks) assert.ok(radius.gates.checks.includes(check), check);
});
