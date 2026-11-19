import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import fc from 'fast-check';
import { isGeometricallyActionable, isPositiveFiniteRect } from '@agent-device/kernel/rect';
import type { Rect } from '@agent-device/kernel/snapshot';
import {
  compareDifferentialCases,
  runSwiftCases,
  SWIFT_RUN_TIMEOUT_MS,
} from '../src/ios-snapshot-engine/conformance-harness.ts';
import {
  swiftToolchainAvailable,
  writeDifferentialFailureArtifact,
} from '../src/ios-snapshot-engine/conformance-harness.fixtures.ts';
import { differentialBatchArbitrary } from '../src/ios-snapshot-engine/conformance-generator.ts';
import { readIosSnapshotEngineFixture } from '../src/ios-snapshot-engine/conformance-fixture.ts';
import {
  hostRowNodes,
  runnerNodes,
  safariWebViewNodes,
  threadNodes,
  viewport as capturedViewport,
} from '../src/ios-snapshot-engine/runner-presentation-fixtures.ts';

type DifferentialCase = Parameters<typeof compareDifferentialCases>[0][number];

const FUZZ_SEEDS = [219101, 219102, 219103, 219104];
const RUNS_PER_SEED = 8;
const MAX_TOTAL_DURATION_MS = 60_000;

const RUNNER_UNSUPPORTED: Readonly<Record<string, string>> = {
  'geometryless cursor nodes keep independent descendants':
    'Swift conformance input requires a rectangle for every node',
  'unavailable hittability fails closed':
    'Swift conformance input requires a resolved hittability bit',
  'malformed parent is a typed failure': 'Swift presenter takes a validated preorder graph',
  'missing viewport is a typed failure':
    'runner route requires a reported viewport for regular payload validation',
  'invalid viewport is a typed failure': 'runner route requires a positive reported viewport',
};

if (!swiftToolchainAvailable()) {
  throw new Error('iOS snapshot differential requires the macOS Swift toolchain');
}

test('authored Swift and TypeScript golden cases agree', { timeout: SWIFT_RUN_TIMEOUT_MS }, () => {
  const fixture = readIosSnapshotEngineFixture();
  const cases = fixture.cases
    .filter((testCase) => testCase.swift)
    .map((testCase) => ({
      name: testCase.name,
      route: 'acquired' as const,
      projection: testCase.projection,
      interactiveOnly: testCase.interactiveOnly,
      depth: testCase.depth,
      scope: testCase.scope,
      foldPolicy: testCase.foldPolicy,
      viewport: fixture.viewport,
      nodes: testCase.nodes,
    }));
  const mismatch = compareDifferentialCases(cases);
  assert.equal(mismatch, undefined, mismatch ? JSON.stringify(mismatch, null, 2) : '');
});

test(
  'Swift presenter and host compaction preserve authored semantic membership',
  { timeout: SWIFT_RUN_TIMEOUT_MS },
  () => {
    const fixture = readIosSnapshotEngineFixture();
    assert.deepEqual(
      fixture.cases
        .filter(
          (testCase) =>
            !testCase.swift &&
            ![
              'interactive only compacts semantic representatives',
              'scroll indicator owned by a parent web view keeps list rows',
            ].includes(testCase.name),
        )
        .map((testCase) => testCase.name),
      Object.keys(RUNNER_UNSUPPORTED),
      'every omitted authored case needs a declared Swift/runner asymmetry',
    );
    assert.ok(Object.values(RUNNER_UNSUPPORTED).every((reason) => reason.length > 0));
    const cases = fixture.cases
      .filter(
        (testCase) =>
          testCase.swift ||
          [
            'interactive only compacts semantic representatives',
            'scroll indicator owned by a parent web view keeps list rows',
          ].includes(testCase.name),
      )
      .map((testCase) => ({
        name: testCase.name,
        route: 'runner-presented' as const,
        projection: testCase.projection,
        interactiveOnly: testCase.interactiveOnly,
        depth: testCase.depth,
        scope: testCase.scope,
        foldPolicy: testCase.foldPolicy,
        viewport: fixture.viewport,
        nodes: testCase.nodes,
      }));
    const mismatch = compareDifferentialCases(cases);
    assert.equal(mismatch, undefined, mismatch ? JSON.stringify(mismatch, null, 2) : '');
  },
);

const CAPTURED_INTERACTIVE_CASES = [
  {
    name: 'Settings chrome',
    nodes: runnerNodes(),
    requiredLabels: ['Screen Time'],
    absentLabels: ['Offscreen'],
  },
  {
    name: 'TextView control',
    nodes: threadNodes(),
    requiredLabels: ['Reply (58 replies)', 'Reply 37', 'Like (0 likes)'],
  },
  {
    name: 'WebView row',
    nodes: hostRowNodes('WebView'),
    requiredLabels: ['Reply (58 replies)', 'Reply 37', 'Like (0 likes)'],
  },
  {
    name: 'paged Cell row',
    nodes: hostRowNodes('Cell'),
    requiredLabels: ['Reply (58 replies)', 'Reply 37', 'Like (0 likes)'],
  },
  {
    name: 'Safari same-frame wrapper',
    nodes: safariWebViewNodes(),
    absentLabels: ['History'],
    clippedLabel: { label: 'iOS - Wikipedia', rect: { x: 0, y: 62, width: 402, height: 750 } },
  },
] as const;

for (const capture of CAPTURED_INTERACTIVE_CASES) {
  test(
    `runner-presented interactive ${capture.name} preserves membership and clipping`,
    { timeout: SWIFT_RUN_TIMEOUT_MS },
    () => {
      const mismatch = compareDifferentialCases([
        {
          ...capture,
          route: 'runner-presented',
          projection: 'regular',
          interactiveOnly: true,
          depth: null,
          scope: null,
          foldPolicy: 'cursor-projected',
          viewport: capturedViewport,
        },
      ]);
      assert.equal(mismatch, undefined, mismatch ? JSON.stringify(mismatch, null, 2) : '');
    },
  );
}

test(
  'raw unscoped depth compares the same acquisition frontier',
  { timeout: SWIFT_RUN_TIMEOUT_MS },
  () => {
    const fixture = readIosSnapshotEngineFixture();
    const depthCase = fixture.cases.find(
      (testCase) => testCase.name === 'raw unscoped depth uses the acquisition frontier',
    );
    assert.ok(depthCase);
    const deepNode = depthCase.nodes.at(-1);
    assert.ok(deepNode);
    const mismatch = compareDifferentialCases([
      {
        name: 'raw-depth-frontier-with-malformed-tail',
        route: 'acquired',
        projection: 'raw',
        interactiveOnly: false,
        depth: 1,
        scope: null,
        foldPolicy: 'cursor-projected',
        viewport: fixture.viewport,
        nodes: [...depthCase.nodes, { ...deepNode, index: 1, parentIndex: 1, depth: 2 }],
      },
    ]);
    assert.equal(mismatch, undefined, mismatch ? JSON.stringify(mismatch, null, 2) : '');
  },
);

test(
  'deterministic Swift/TypeScript differential fuzz stays under 60000ms',
  { timeout: SWIFT_RUN_TIMEOUT_MS * FUZZ_SEEDS.length },
  () => {
    const startedAt = performance.now();
    for (const seed of FUZZ_SEEDS) {
      assertDifferentialSeed(seed);
      assertWithinKillCriterion(startedAt, seed);
    }
  },
);

function assertDifferentialSeed(seed: number): void {
  const result = fc.check(
    fc.property(
      differentialBatchArbitrary,
      (cases) => compareDifferentialCases(cases) === undefined,
    ),
    {
      seed,
      numRuns: RUNS_PER_SEED,
      endOnFailure: true,
      interruptAfterTimeLimit: SWIFT_RUN_TIMEOUT_MS,
    },
  );
  if (!result.failed) return;

  const counterexample = Array.isArray(result.counterexample?.[0])
    ? (result.counterexample[0] as DifferentialCase[])
    : [];
  const mismatch = compareDifferentialCases(counterexample);
  const testCase = mismatch?.case ?? counterexample[0];
  if (!testCase) {
    throw new Error('differential fuzz failed without a reproducible case: ' + String(result));
  }
  const artifact = writeDifferentialFailureArtifact({
    testCase,
    seed,
    counterexamplePath: result.counterexamplePath ?? 'unknown',
  });
  throw new Error(
    'Swift/TypeScript differential mismatch for ' +
      testCase.name +
      '; minimal case: ' +
      artifact.casePath +
      '; replay: ' +
      artifact.replayCommand,
  );
}

function assertWithinKillCriterion(startedAt: number, seed: number): void {
  if (performance.now() - startedAt <= MAX_TOTAL_DURATION_MS) return;
  throw new Error(
    'differential fuzz exceeded its ' +
      String(MAX_TOTAL_DURATION_MS) +
      'ms kill criterion after seed ' +
      String(seed),
  );
}

type ActionabilityRect = Readonly<{ x: number; y: number; width: number; height: number }>;
type ActionabilityUnusableRect = Readonly<{ infinite: true }> | Readonly<{ nonFinite: true }>;
type ActionabilityViewport =
  | Readonly<{ kind: 'reported' | 'derived'; rect: ActionabilityRect }>
  | Readonly<{ kind: 'missing'; reason: 'not-provided' | 'invalid' }>;
type ActionabilityVector = Readonly<{
  name: string;
  swift: boolean;
  typescript: boolean;
  asymmetry?: string;
  enabled: boolean;
  node: ActionabilityRect | ActionabilityUnusableRect;
  viewport: ActionabilityViewport;
  /** `null` is the absent bit. */
  hittable: boolean | null;
  nodeRectGuardPasses: boolean;
}>;

const ACTIONABILITY_POLICY_PATH = path.resolve(
  import.meta.dirname,
  '..',
  '..',
  '..',
  'contracts',
  'fixtures',
  'snapshot-actionability-policy.json',
);

/** A box whose components are not numbers anything may plot. JSON has no literal for infinity. */
const NON_FINITE_RECT: Rect = {
  x: Number.NEGATIVE_INFINITY,
  y: Number.NEGATIVE_INFINITY,
  width: Number.POSITIVE_INFINITY,
  height: Number.POSITIVE_INFINITY,
};

/**
 * What `{"infinite": true}` means on this side: `CGRect.infinite` spelled in the doubles Apple
 * spells it with, which is exactly the shape a failed read arrives in over a JSON wire.
 */
const CG_RECT_INFINITE: Rect = {
  x: -Number.MAX_VALUE / 2,
  y: -Number.MAX_VALUE / 2,
  width: Number.MAX_VALUE,
  height: Number.MAX_VALUE,
};

function declaresItsAsymmetry(vector: ActionabilityVector): boolean {
  const hasReason = typeof vector.asymmetry === 'string' && vector.asymmetry.length > 0;
  return (vector.swift && vector.typescript) !== hasReason;
}

function readActionabilityVectors(): readonly ActionabilityVector[] {
  const table = JSON.parse(fs.readFileSync(ACTIONABILITY_POLICY_PATH, 'utf8')) as {
    cases: readonly ActionabilityVector[];
  };
  assert.ok(table.cases.length > 0, 'actionability vector table must not be empty');
  assert.equal(
    new Set(table.cases.map((vector) => vector.name)).size,
    table.cases.length,
    'actionability vector names must be unique',
  );
  for (const vector of table.cases) {
    assert.equal(typeof vector.swift, 'boolean', `${vector.name}: row must declare the Swift side`);
    assert.equal(
      typeof vector.typescript,
      'boolean',
      `${vector.name}: row must declare the TypeScript side`,
    );
    assert.ok(
      vector.swift || vector.typescript,
      `${vector.name}: a row no language runs asserts nothing`,
    );
    assert.ok(
      declaresItsAsymmetry(vector),
      `${vector.name}: a row both languages do not share must name the asymmetry`,
    );
  }
  return table.cases;
}

function toRect(node: ActionabilityVector['node']): Rect {
  if ('nonFinite' in node) return NON_FINITE_RECT;
  if ('infinite' in node) return CG_RECT_INFINITE;
  return node;
}

// The Swift twin of these rows is ActionabilityPolicyTests, run by `swift test --package-path
// apple/snapshot-presentation` in this same command.
test('the shared hittable predicate agrees with every golden actionability vector', () => {
  for (const vector of readActionabilityVectors().filter((row) => row.typescript)) {
    const node = toRect(vector.node);
    assert.equal(
      isPositiveFiniteRect(node),
      vector.nodeRectGuardPasses,
      `${vector.name}: node-rect guard`,
    );
    if (vector.viewport.kind === 'missing') {
      assert.fail(
        `${vector.name}: the TypeScript predicate takes a box, so this row is Swift-only`,
      );
    }
    assert.equal(
      isGeometricallyActionable(vector.enabled, node, vector.viewport.rect),
      vector.hittable,
      vector.name,
    );
  }
});

/**
 * Non-vacuity for the row that started #2891: `CGRect.infinite` is built of finite components and
 * finite extents, so if this spelling ever stopped being a value the numeric checks accept, the
 * sentinel row would be silently replaying some other unusable box and the sentinel would go
 * untested on this side.
 */
test('the infinite row is a box only the guard itself can refuse', () => {
  const box = [
    CG_RECT_INFINITE.x,
    CG_RECT_INFINITE.y,
    CG_RECT_INFINITE.width,
    CG_RECT_INFINITE.height,
  ];
  assert.ok(
    box.every(Number.isFinite),
    "CGRect.infinite's components are finite Doubles; a spelling that is not cannot stand for it",
  );
  assert.ok(
    [
      CG_RECT_INFINITE.x + CG_RECT_INFINITE.width,
      CG_RECT_INFINITE.y + CG_RECT_INFINITE.height,
    ].every(Number.isFinite),
    "CGRect.infinite's extents are finite too, so an extent check alone would accept it",
  );
  assert.equal(
    isPositiveFiniteRect(CG_RECT_INFINITE),
    false,
    "the guard itself is what refuses Apple's no-box sentinel",
  );
});

test('the TypeScript rows cover every viewport kind that carries a box', () => {
  const vectors = readActionabilityVectors().filter((row) => row.typescript);
  assert.deepEqual([...new Set(vectors.map((vector) => vector.viewport.kind))].sort(), [
    'derived',
    'reported',
  ]);
});

test('regular tvOS tree captures publish focus on the surviving tile as focus moves', () => {
  const cases = ([0, 1, 2] as const).flatMap((focusedTile) =>
    (['regular', 'interactive', 'raw'] as const).map((mode) => ({
      name: `${mode} tile ${focusedTile + 1}`,
      route: 'runner-presented' as const,
      projection: mode === 'raw' ? ('raw' as const) : ('regular' as const),
      interactiveOnly: mode === 'interactive',
      depth: null,
      scope: null,
      foldPolicy: 'plain-viewport' as const,
      regularTreePolicy: 'tvOS' as const,
      viewport: { x: 0, y: 0, width: 1920, height: 1080 },
      nodes: tvFocusRow(focusedTile),
      focusedTile,
    })),
  );
  const swiftCases = runSwiftCases(cases);
  for (const [index, testCase] of cases.entries()) {
    const swift = swiftCases[index]!;
    assert.equal(swift.outcome, 'success', testCase.name);
    const raw = testCase.projection === 'raw';
    const { presented, state } = JSON.parse(
      execFileSync(
        'pnpm',
        ['--silent', '--filter', '@agent-device/platform-apple', 'test:tvos-snapshot-presentation'],
        {
          encoding: 'utf8',
          input: JSON.stringify({
            nodes: swift.rawNodes,
            viewport: testCase.viewport,
            raw,
            interactiveOnly: testCase.interactiveOnly,
          }),
        },
      ),
    ) as {
      presented: { nodes: NonNullable<typeof swift.rawNodes> };
      state: { nodes: NonNullable<typeof swift.rawNodes> };
    };

    for (const nodes of [swift.rawNodes!, presented.nodes, state.nodes]) {
      const focused = nodes.filter((node) => node.focused === true);
      assert.deepEqual(
        focused.map((node) => [
          node.type,
          node.label,
          node.rect && Number(node.rect.width.toFixed(9)),
          node.hittable,
        ]),
        [['Other', `Tile ${testCase.focusedTile + 1}`, raw ? 333.5 : 333.6, true]],
        testCase.name,
      );
    }
    const scaled = {
      x: TILE_ORIGINS[testCase.focusedTile] - 8.3375,
      y: 197.475,
      width: 350.175,
      height: 526.05,
    };
    const geometryViews = testCase.interactiveOnly
      ? [swift.rawNodes!]
      : [swift.rawNodes!, presented.nodes, state.nodes];
    for (const nodes of geometryViews) {
      assert.ok(
        nodes.some(
          ({ rect }) =>
            rect &&
            (['x', 'y', 'width', 'height'] as const).every(
              (key) => Math.abs(rect[key] - scaled[key]) < 1e-9,
            ),
        ),
        `${testCase.name} keeps the focus-scaled frame`,
      );
    }
    assert.ok(state.nodes.find((node) => node.focused)?.ref, testCase.name);
  }
});

test('regular tree focus stays on the same branch and keeps each Apple identity policy', () => {
  const nodes = tvFocusRow(0);
  const base = {
    route: 'runner-presented',
    projection: 'regular',
    interactiveOnly: false,
    depth: null,
    scope: null,
    foldPolicy: 'plain-viewport',
    viewport: { x: 0, y: 0, width: 1920, height: 1080 },
  } as const;
  const siblingNodes = nodes.map((node) => {
    if (node.focused) return { ...node, parentIndex: 4, depth: 5 };
    if (node.parentIndex === 6) return { ...node, depth: 6 };
    return node;
  });
  const cases = runSwiftCases([
    { ...base, name: 'full bounds', regularTreePolicy: 'fullBounds', nodes },
    { ...base, name: 'origin only', regularTreePolicy: 'originOnly', nodes },
    {
      ...base,
      name: 'tvOS sibling duplicate',
      regularTreePolicy: 'tvOS',
      nodes: siblingNodes,
    },
  ]);
  for (const outcome of cases) assert.equal(outcome.outcome, 'success');
  assert.deepEqual(
    cases.map((outcome) =>
      outcome.rawNodes?.filter((node) => node.focused).map((node) => node.rect?.width),
    ),
    [[333.5], [], []],
  );
});

const TILE_ORIGINS = [96, 441.5, 787] as const;

function tvFocusRow(focusedTile: number): DifferentialCase['nodes'] {
  const viewport = { x: 0, y: 0, width: 1920, height: 1080 };
  const row = { x: 0, y: 210, width: 1920, height: 501 };
  const facts = { enabled: true, hittable: true };
  return [
    { ...facts, index: 0, depth: 0, type: 'Application', rect: viewport, hittable: false },
    {
      ...facts,
      index: 1,
      depth: 1,
      parentIndex: 0,
      type: 'CollectionView',
      rect: viewport,
      identifier: 'home-collection',
    },
    { ...facts, index: 2, depth: 2, parentIndex: 1, type: 'Cell', rect: row },
    { ...facts, index: 3, depth: 3, parentIndex: 2, type: 'CollectionView', rect: row },
    ...TILE_ORIGINS.flatMap((x, tile) => {
      const index = 4 + tile * 4;
      const label = `Tile ${tile + 1}`;
      const rect = { x, y: 210, width: 333.6, height: 501 };
      return [
        {
          ...facts,
          index,
          depth: 4,
          parentIndex: 3,
          type: 'Cell',
          identifier: `tile-cell-${tile + 1}`,
          rect,
        },
        { ...facts, index: index + 1, depth: 5, parentIndex: index, type: 'Other', label, rect },
        {
          ...facts,
          index: index + 2,
          depth: 6,
          parentIndex: index + 1,
          type: 'Other',
          label,
          rect: { ...rect, width: 333.5 },
          ...(tile === focusedTile ? { focused: true } : {}),
        },
        ...(tile === focusedTile
          ? [
              {
                ...facts,
                index: index + 3,
                depth: 7,
                parentIndex: index + 2,
                type: 'Other',
                label,
                rect: { x: x - 8.3375, y: 197.475, width: 350.175, height: 526.05 },
              },
            ]
          : []),
      ];
    }),
  ];
}
