import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  coverageSummary,
  depgraphFacts,
  groupChangedFiles,
  parseLayeringReport,
  renderEvidence,
  sizeSummary,
  type EvidenceInputs,
} from './model.ts';

const HEAD = 'b03379a55baa9f6da5d863e6dcfccdcfef975f5c';
const BASE = '9a0d6dead229fc82e7e61064f674f963197afc4b';

function inputs(overrides: Partial<EvidenceInputs> = {}): EvidenceInputs {
  return {
    generatedAt: '2026-08-18T14:35:58.105Z',
    repository: 'callstack/agent-device',
    git: {
      branch: 'feat/x',
      head: HEAD,
      headShort: HEAD.slice(0, 9),
      base: BASE,
      baseRef: 'origin/main',
      baseShort: BASE.slice(0, 9),
      dirty: false,
      changedFiles: ['src/daemon/a.ts', 'src/daemon/b.ts', 'docs/agents/testing.md', 'AGENTS.md'],
    },
    affected: {
      failOpen: false,
      failOpenReasons: [],
      checks: [
        { id: 'typecheck', localRunnable: true, ciJobs: ['Lint & Format'] },
        { id: 'unit', localRunnable: true, ciJobs: ['Unit'] },
        { id: 'swift-runner-ios', localRunnable: false, ciJobs: ['iOS'] },
      ],
    },
    layering: { ok: true, violationsByRule: {} },
    depgraph: {
      head: {
        files: 1312,
        edges: 5559,
        typeInversions: 7,
        daemonToPlatforms: { count: 62, valueCount: 43 },
      },
      base: {
        files: 1311,
        edges: 5556,
        typeInversions: 7,
        daemonToPlatforms: { count: 64, valueCount: 45 },
      },
    },
    coverage: { kind: 'skipped', reason: 'pass --coverage' },
    size: { kind: 'skipped', reason: 'pass --size' },
    ...overrides,
  };
}

test('changed files group by top-level area, largest first, root files under (root)', () => {
  assert.deepEqual(
    [...groupChangedFiles(['src/a.ts', 'docs/b.md', 'src/c.ts', 'AGENTS.md', 'scripts/d.ts'])],
    [
      ['src', 2],
      ['(root)', 1],
      ['docs', 1],
      ['scripts', 1],
    ],
  );
});

test('the layering report parses per-rule counts and takes OK from the exit code', () => {
  const red = parseLayeringReport(
    'Layering guard: 2 violation(s)\n\n  [R9 type-cycle-size] 1 violation(s):\n::error …\n  [R10 daemon-modularity] 1 violation(s):\n',
    1,
  );
  assert.deepEqual(red, {
    ok: false,
    violationsByRule: { 'R9 type-cycle-size': 1, 'R10 daemon-modularity': 1 },
  });
  assert.deepEqual(parseLayeringReport('Layering guard: OK — 1312 source files …\n', 0), {
    ok: true,
    violationsByRule: {},
  });
});

test('depgraph facts read the counts and the daemon→platforms zone edge', () => {
  assert.deepEqual(
    depgraphFacts({
      generated: { files: 3, edges: 4 },
      zoneEdges: [
        { from: 'daemon-server', to: 'contracts', count: 9, valueCount: 5 },
        { from: 'daemon-server', to: 'platforms', count: 62, valueCount: 43 },
      ],
      typeInversions: { 'commands -> client': 3, 'core -> daemon-server': 2 },
    }),
    { files: 3, edges: 4, typeInversions: 5, daemonToPlatforms: { count: 62, valueCount: 43 } },
  );
  assert.equal(
    depgraphFacts({ generated: { files: 1, edges: 0 }, zoneEdges: [], typeInversions: {} })
      .daemonToPlatforms,
    undefined,
  );
});

test('the block is stamped with full base and head SHAs and reports deltas against base', () => {
  const block = renderEvidence(inputs());
  assert.match(block, new RegExp(`^<!-- pr-evidence base=${BASE} head=${HEAD} -->\n`));
  assert.match(block, /at `b03379a55` \(`feat\/x`\) against `origin\/main` @ `9a0d6dead`/);
  assert.match(block, /Changed: 4 files \(2 src, 1 \(root\), 1 docs\)/);
  assert.match(
    block,
    /3 selected · local: typecheck, unit · GitHub-authoritative: swift-runner-ios/,
  );
  assert.match(
    block,
    /Layering guard: OK · graph 1312 files \(\+1 vs base\), 5559 edges \(\+3 vs base\), type inversions 7 \(±0\) · daemon→platforms 62 total \(-2 vs base\) \/ 43 value \(-2 vs base\)/,
  );
  assert.match(block, /Coverage: not measured \(pass --coverage\)/);
  assert.match(block, /Size: not measured \(pass --size\)/);
  assert.match(block, new RegExp(`commit/${HEAD}/checks$`, 'm'));
  assert.doesNotMatch(block, /dirty/);
});

test('a dirty tree is called out and a fail-open plan is summarized, not enumerated', () => {
  const block = renderEvidence(
    inputs({
      git: { ...inputs().git, dirty: true },
      affected: {
        failOpen: true,
        failOpenReasons: [
          { path: 'scripts/x.ts', rule: 'workflow-tooling' },
          { path: 'scripts/y.ts', rule: 'workflow-tooling' },
        ],
        checks: [
          { id: 'a', localRunnable: true, ciJobs: [] },
          { id: 'b', localRunnable: false, ciJobs: [] },
        ],
      },
      layering: { ok: false, violationsByRule: { 'R9 type-cycle-size': 1 } },
      depgraph: { ...inputs().depgraph, base: undefined },
    }),
  );
  assert.match(block, /working tree dirty: describes the tree, not the head/);
  assert.match(
    block,
    /fail-open \(workflow-tooling\): full set, 1 local \+ 1 GitHub-authoritative/,
  );
  assert.doesNotMatch(block, /local: a/);
  assert.match(block, /Layering guard: R9 type-cycle-size ×1 · graph 1312 files, 5559 edges,/);
});

test('coverage and size summaries lift one line out of the tools’ own markdown', () => {
  assert.equal(
    coverageSummary(
      '## Changed-line coverage gate: PASS\n\n| Metric | Value |\n| --- | --- |\n| Changed-line coverage (gating, threshold 80%) | 24/26 (92.31%) |\n',
    ),
    '24/26 (92.31%), threshold 80% — PASS',
  );
  assert.equal(
    sizeSummary(
      '| Metric | Base | Current | Diff |\n|---|---:|---:|---:|\n| JS raw | 2.30 MB | 2.30 MB | +99 B |\n| JS gzip | 756.3 kB | 756.4 kB | +50 B |\n',
    ),
    'JS gzip 756.4 kB (+50 B vs base)',
  );
  assert.equal(coverageSummary('nothing'), 'report present, no gating row found');
  assert.equal(sizeSummary('nothing'), 'report present, no JS gzip row found');
});
