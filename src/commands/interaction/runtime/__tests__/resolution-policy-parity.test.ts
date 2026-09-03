import assert from 'node:assert/strict';
import { test } from 'vitest';
import type { SnapshotNode } from '@agent-device/kernel/snapshot';
import { SELECTOR_RESOLUTION_POLICIES } from '@agent-device/selectors';
// The engine's own subpath (#1656): this file pins what a ROW means to the
// engine, so it is the one consumer that legitimately holds it directly. R19
// governs shipped routes — the layering scan reads production sources only.
import { resolveSelectorChainWithPolicy } from '@agent-device/selectors/engine';

/**
 * The matrix is exercised through the interface callers actually use
 * (`resolveSelectorChainWithPolicy` — since #1630 the façade's only
 * resolution entry) against fixture trees, so each row's ambiguity contract
 * is proven behaviorally rather than asserted about source text. A row that
 * stops matching its documented semantics fails here even though the
 * declaration still reads plausibly.
 *
 * Which row each CALLER consumes is a separate question, pinned end to end in
 * selector-read-policy.test.ts.
 */

function node(index: number, label: string, overrides: Partial<SnapshotNode> = {}): SnapshotNode {
  return {
    ref: `e${index}`,
    index,
    depth: 1,
    type: 'Button',
    label,
    rect: { x: 0, y: index * 40, width: 100, height: 30 },
    ...overrides,
  } as SnapshotNode;
}

/** Two nodes share a label: every ambiguity contract has to say something. */
const AMBIGUOUS_TREE: SnapshotNode[] = [node(0, 'Save'), node(1, 'Save'), node(2, 'Cancel')];
/**
 * Same ambiguity, but the candidates differ in depth/area, so the engine's
 * visible→deepest→smallest-area tiebreak CAN pick a winner. Kept separate
 * from AMBIGUOUS_TREE because indistinguishable candidates are exactly the
 * case where disambiguation must decline (below).
 */
const TIEBREAKABLE_TREE: SnapshotNode[] = [
  node(0, 'Save', { rect: { x: 0, y: 0, width: 300, height: 200 } }),
  node(1, 'Save', { depth: 3, rect: { x: 10, y: 10, width: 80, height: 24 } }),
  node(2, 'Cancel'),
];
const UNIQUE_TREE: SnapshotNode[] = [node(0, 'Save'), node(1, 'Cancel')];
/** Rectless nodes: only rect-requiring rows should reject these. */
const RECTLESS_TREE: SnapshotNode[] = [node(0, 'Save', { rect: undefined })];

const OPTIONS = { platform: 'ios' as const };

function outcomeFor(policyName: keyof typeof SELECTOR_RESOLUTION_POLICIES, tree: SnapshotNode[]) {
  return resolveSelectorChainWithPolicy(
    tree,
    'label="Save"',
    SELECTOR_RESOLUTION_POLICIES[policyName],
    OPTIONS,
  );
}

test('a unique match resolves under every policy', () => {
  for (const name of Object.keys(
    SELECTOR_RESOLUTION_POLICIES,
  ) as (keyof typeof SELECTOR_RESOLUTION_POLICIES)[]) {
    const outcome = outcomeFor(name, UNIQUE_TREE);
    assert.equal(outcome.kind, 'resolved', name);
    if (outcome.kind === 'resolved') assert.equal(outcome.resolution.node.label, 'Save');
  }
});

test('the façade returns selector TEXT under every policy, never a parser node', () => {
  // #1589 made the root façade string-in/string-out and confined parser
  // objects to `@agent-device/selectors/ast`. A nested return type reopens
  // that boundary invisibly: the package-boundary gate filters exported
  // *names*, so `PolicyResolutionOutcome.resolution` typed as the AST shape
  // stayed green while production read `outcome.resolution.selector.raw`.
  // Every row, and both branches that carry a selector.
  for (const name of Object.keys(
    SELECTOR_RESOLUTION_POLICIES,
  ) as (keyof typeof SELECTOR_RESOLUTION_POLICIES)[]) {
    const resolved = outcomeFor(name, UNIQUE_TREE);
    assert.equal(resolved.kind, 'resolved', name);
    if (resolved.kind === 'resolved') {
      assert.equal(typeof resolved.resolution.selector, 'string', name);
      assert.equal(resolved.resolution.selector, 'label="Save"', name);
    }
    const ambiguous = outcomeFor(name, AMBIGUOUS_TREE);
    if (ambiguous.kind === 'ambiguous') {
      assert.equal(typeof ambiguous.selector, 'string', name);
    } else if (ambiguous.kind === 'resolved') {
      assert.equal(typeof ambiguous.resolution.selector, 'string', name);
    }
  }
});

test('no match resolves to none under every policy', () => {
  for (const name of Object.keys(
    SELECTOR_RESOLUTION_POLICIES,
  ) as (keyof typeof SELECTOR_RESOLUTION_POLICIES)[]) {
    const outcome = resolveSelectorChainWithPolicy(
      UNIQUE_TREE,
      'label="Absent"',
      SELECTOR_RESOLUTION_POLICIES[name],
      OPTIONS,
    );
    assert.equal(outcome.kind, 'none', name);
  }
});

test('disambiguating rows pick the tiebreak winner and disclose the match count', () => {
  for (const name of ['readText'] as const) {
    const outcome = outcomeFor(name, TIEBREAKABLE_TREE);
    assert.equal(outcome.kind, 'resolved', name);
    if (outcome.kind === 'resolved') {
      assert.equal(outcome.resolution.matches, 2, `${name} discloses the real match count`);
      assert.equal(outcome.resolution.node.index, 1, `${name} takes the deepest/smallest`);
    }
  }
});

test('disambiguation declines when candidates are genuinely indistinguishable', () => {
  // The tiebreak is evidence, not a coin flip: identical candidates must not
  // silently bind one. Acting rows surface the ambiguity instead.
  for (const name of ['act', 'readText'] as const) {
    assert.equal(outcomeFor(name, AMBIGUOUS_TREE).kind, 'ambiguous', name);
  }
});

test('fail-closed rows refuse an ambiguous tree instead of guessing', () => {
  for (const name of ['readUnique', 'cropTarget'] as const) {
    const outcome = outcomeFor(name, AMBIGUOUS_TREE);
    assert.equal(outcome.kind, 'ambiguous', name);
    if (outcome.kind === 'ambiguous') assert.equal(outcome.matchedNodes.length, 2, name);
  }
});

test('first-match rows take the head of an ambiguous tree', () => {
  for (const name of ['readAny', 'wait', 'actCoveredDiagnosis'] as const) {
    const outcome = outcomeFor(name, AMBIGUOUS_TREE);
    assert.equal(outcome.kind, 'resolved', name);
    if (outcome.kind === 'resolved') assert.equal(outcome.resolution.node.index, 0, name);
  }
});

test('reject-candidates surfaces every candidate for the caller to narrow or refuse', () => {
  for (const name of ['act', 'findAct'] as const) {
    const outcome = outcomeFor(name, AMBIGUOUS_TREE);
    assert.equal(outcome.kind, 'ambiguous', name);
    if (outcome.kind === 'ambiguous') {
      assert.deepEqual(
        outcome.matchedNodes.map((n) => n.index),
        [0, 1],
      );
    }
  }
});

test('rect-requiring rows skip rectless nodes; read and wait rows accept them', () => {
  for (const name of ['act', 'findAct', 'actCoveredDiagnosis', 'cropTarget'] as const) {
    assert.equal(outcomeFor(name, RECTLESS_TREE).kind, 'none', name);
  }
  for (const name of ['readUnique', 'readAny', 'readText', 'wait'] as const) {
    assert.equal(outcomeFor(name, RECTLESS_TREE).kind, 'resolved', name);
  }
});

/**
 * The matrix may only declare what it can enforce (#1649 review). An earlier
 * revision carried occlusion / off-screen / promotion / poll columns that no
 * code consumed, so changing them left both behavior and the suite green —
 * an unverifiable claim reading as truth. Those four stages belong to the
 * structural table (`src/core/selector-pipeline-policy.ts`, #1656), where
 * runners consume them; this still fails if such a field appears HERE, where
 * the selectors package has nothing to enforce it with.
 */
test('policy rows declare only the fields this matrix actually enforces', () => {
  for (const [name, policy] of Object.entries(SELECTOR_RESOLUTION_POLICIES)) {
    assert.deepEqual(
      Object.keys(policy).sort(),
      ['ambiguity', 'requireRect'],
      `${name} declares a field the matrix cannot enforce`,
    );
  }
});

test('the documented per-caller contracts are the ones declared', () => {
  assert.equal(SELECTOR_RESOLUTION_POLICIES.act.ambiguity, 'reject-candidates');
  assert.equal(SELECTOR_RESOLUTION_POLICIES.readText.ambiguity, 'disambiguate');
  assert.equal(SELECTOR_RESOLUTION_POLICIES.readUnique.ambiguity, 'fail-closed');
  assert.equal(SELECTOR_RESOLUTION_POLICIES.readAny.ambiguity, 'first-match');
  assert.equal(SELECTOR_RESOLUTION_POLICIES.wait.ambiguity, 'first-match');
  assert.equal(SELECTOR_RESOLUTION_POLICIES.findAct.ambiguity, 'reject-candidates');
  assert.equal(SELECTOR_RESOLUTION_POLICIES.cropTarget.ambiguity, 'fail-closed');
});
