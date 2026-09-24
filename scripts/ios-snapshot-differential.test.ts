import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import fc from 'fast-check';
import { isGeometricallyActionable, isPositiveFiniteRect } from '@agent-device/kernel/rect';
import type { Rect } from '@agent-device/kernel/snapshot';
import {
  compareDifferentialCases,
  swiftToolchainAvailable,
  SWIFT_RUN_TIMEOUT_MS,
  writeDifferentialFailureArtifact,
} from '../packages/capture-kit/src/ios-snapshot-engine/conformance-harness.ts';
import { differentialBatchArbitrary } from '../packages/capture-kit/src/ios-snapshot-engine/conformance-generator.ts';
import { readIosSnapshotEngineFixture } from '../packages/capture-kit/src/ios-snapshot-engine/conformance-fixture.ts';

type DifferentialCase = Parameters<typeof compareDifferentialCases>[0][number];

const FUZZ_SEEDS = [219101, 219102, 219103, 219104];
const RUNS_PER_SEED = 8;
const MAX_TOTAL_DURATION_MS = 60_000;

if (!swiftToolchainAvailable()) {
  throw new Error('iOS snapshot differential requires the macOS Swift toolchain');
}

test('authored Swift and TypeScript golden cases agree', { timeout: SWIFT_RUN_TIMEOUT_MS }, () => {
  const fixture = readIosSnapshotEngineFixture();
  const cases = fixture.cases
    .filter((testCase) => testCase.swift && !testCase.interactiveOnly)
    .map((testCase) => ({
      name: testCase.name,
      projection: testCase.projection,
      interactiveOnly: false as const,
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
