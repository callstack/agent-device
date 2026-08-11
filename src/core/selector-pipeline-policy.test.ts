import assert from 'node:assert/strict';
import { test } from 'vitest';
import type { RawSnapshotNode } from '@agent-device/kernel/snapshot';
import { SELECTOR_RESOLUTION_POLICIES } from '@agent-device/selectors';
import { makeSnapshotState } from '../__tests__/test-utils/index.ts';
import {
  SELECTOR_PIPELINE_POLICIES,
  resolveSelectorPipelineTarget,
  selectorPipelineCandidates,
  selectorPipelineRefusesOffscreen,
  selectorPollBudget,
  type SelectorPipelinePolicyName,
} from './selector-pipeline-policy.ts';

/**
 * #1656: every row is driven through every runner — including the rows whose
 * answer is "skip this stage", since a skip nothing exercises is a claim that
 * cannot fail. Flip any cell in the table and an assertion here changes.
 *
 * Which stages a given CALLER runs is a separate question, pinned by the
 * caller-level suites (resolution.test.ts, find handler tests, selector-read
 * policy tests).
 */

const ROWS = Object.keys(SELECTOR_PIPELINE_POLICIES) as SelectorPipelinePolicyName[];

/** A covered button beside an uncovered twin, under a full-screen root. */
const COVERED_TREE: RawSnapshotNode[] = [
  {
    index: 0,
    depth: 0,
    type: 'XCUIElementTypeApplication',
    rect: { x: 0, y: 0, width: 390, height: 844 },
    hittable: true,
  },
  {
    index: 1,
    depth: 1,
    parentIndex: 0,
    type: 'XCUIElementTypeButton',
    label: 'Save',
    rect: { x: 20, y: 700, width: 100, height: 40 },
    hittable: false,
    interactionBlocked: 'covered',
  },
  {
    index: 2,
    depth: 1,
    parentIndex: 0,
    type: 'XCUIElementTypeButton',
    label: 'Save',
    rect: { x: 20, y: 200, width: 100, height: 40 },
    hittable: true,
  },
];

/** Static text inside a hittable row: the shape promotion exists for. */
const PROMOTABLE_TREE: RawSnapshotNode[] = [
  {
    index: 0,
    depth: 0,
    type: 'XCUIElementTypeCell',
    label: 'Account row',
    rect: { x: 10, y: 20, width: 300, height: 60 },
    hittable: true,
  },
  {
    index: 1,
    depth: 1,
    parentIndex: 0,
    type: 'XCUIElementTypeStaticText',
    label: 'Account',
    rect: { x: 24, y: 32, width: 80, height: 20 },
    hittable: false,
  },
];

/**
 * A full-screen group whose only hittable ancestor IS the viewport root: the
 * one tree where the two promoting stages disagree.
 */
const ROOT_ANCESTOR_TREE: RawSnapshotNode[] = [
  {
    index: 0,
    depth: 0,
    type: 'XCUIElementTypeApplication',
    rect: { x: 0, y: 0, width: 390, height: 844 },
    hittable: true,
  },
  {
    index: 1,
    depth: 1,
    parentIndex: 0,
    type: 'XCUIElementTypeGroup',
    label: 'Content',
    rect: { x: 0, y: 0, width: 390, height: 844 },
    hittable: false,
  },
];

function nodesOf(raw: RawSnapshotNode[]) {
  return makeSnapshotState(raw).nodes;
}

function candidateIndexes(row: SelectorPipelinePolicyName): number[] {
  return selectorPipelineCandidates(SELECTOR_PIPELINE_POLICIES[row], nodesOf(COVERED_TREE)).map(
    (node) => node.index,
  );
}

function targetFor(row: SelectorPipelinePolicyName, raw: RawSnapshotNode[], index: number) {
  const nodes = nodesOf(raw);
  return resolveSelectorPipelineTarget(SELECTOR_PIPELINE_POLICIES[row], nodes, nodes[index]!);
}

test('the occlusion stage decides candidacy: acting rows drop covered nodes, the rest keep them', () => {
  for (const row of ['promotedTarget', 'resolvedTarget'] as const) {
    assert.deepEqual(candidateIndexes(row), [0, 2], row);
  }
  // `refuse` rows see covered nodes (find ranks them, the probe diagnoses
  // them) and `ignore` rows answer about the tree as captured.
  for (const row of ['findAct', 'coveredDiagnosis', 'readText', 'readUnique'] as const) {
    assert.deepEqual(candidateIndexes(row), [0, 1, 2], row);
  }
  for (const row of ['readAny', 'wait', 'findWait'] as const) {
    assert.deepEqual(candidateIndexes(row), [0, 1, 2], row);
  }
});

test('the occlusion stage decides refusal: every row that refuses covered targets, and every row that does not', () => {
  for (const row of ['promotedTarget', 'resolvedTarget', 'findAct', 'coveredDiagnosis'] as const) {
    const target = targetFor(row, COVERED_TREE, 1);
    assert.equal(target.kind, 'occluded', row);
    assert.equal(target.node.index, 1, row);
  }
  for (const row of ['readText', 'readUnique', 'readAny', 'wait', 'findWait'] as const) {
    const target = targetFor(row, COVERED_TREE, 1);
    assert.equal(target.kind, 'target', row);
    assert.equal(target.node.index, 1, row);
  }
});

test('the promotion stage retargets only for the rows that declare it', () => {
  // Same tree, same node: the row is the whole difference.
  assert.equal(targetFor('promotedTarget', PROMOTABLE_TREE, 1).node.index, 0);
  assert.equal(targetFor('findAct', PROMOTABLE_TREE, 1).node.index, 0);
  for (const row of ['resolvedTarget', 'readText', 'readUnique', 'readAny', 'wait'] as const) {
    assert.equal(targetFor(row, PROMOTABLE_TREE, 1).node.index, 1, row);
  }
});

test('find’s promotion stops below the viewport root; the tap row does not', () => {
  // `find` ranks matches across the whole tree, so a promotion that lands on
  // the root container would turn "the thing that matched" into "the screen".
  assert.equal(targetFor('promotedTarget', ROOT_ANCESTOR_TREE, 1).node.index, 0);
  assert.equal(targetFor('findAct', ROOT_ANCESTOR_TREE, 1).node.index, 1);
});

test('the off-screen stage refuses for acting rows and is skipped by observation rows', () => {
  // The guard itself (including the iOS live-rect rescue) is exercised in
  // commands/interaction/runtime/resolution.test.ts; this pins which rows
  // reach it at all.
  for (const row of ['promotedTarget', 'resolvedTarget'] as const) {
    assert.equal(selectorPipelineRefusesOffscreen(SELECTOR_PIPELINE_POLICIES[row]), true, row);
  }
  for (const row of ROWS.filter((name) => name !== 'promotedTarget' && name !== 'resolvedTarget')) {
    assert.equal(selectorPipelineRefusesOffscreen(SELECTOR_PIPELINE_POLICIES[row]), false, row);
  }
});

test('the poll stage answers only for the rows that poll', () => {
  for (const row of ['wait', 'findWait'] as const) {
    assert.deepEqual(selectorPollBudget(SELECTOR_PIPELINE_POLICIES[row]), {
      defaultTimeoutMs: 10_000,
      intervalMs: 300,
    });
  }
  for (const row of ROWS.filter((name) => name !== 'wait' && name !== 'findWait')) {
    assert.throws(() => selectorPollBudget(SELECTOR_PIPELINE_POLICIES[row]), /no poll budget/, row);
  }
});

test('pipeline rows declare only the stages these runners enforce', () => {
  // The #1649 rule, carried to this table: a column nothing consumes is an
  // unverifiable claim that reads as truth. Adding a field here fails until a
  // runner above reads it and this suite drives every row through it.
  for (const [name, policy] of Object.entries(SELECTOR_PIPELINE_POLICIES)) {
    assert.deepEqual(
      Object.keys(policy).sort(),
      ['occlusion', 'offscreen', 'poll', 'promotion', 'resolution'],
      `${name} declares a stage no runner consumes`,
    );
  }
});

test('every ambiguity row is named by a pipeline row', () => {
  // The two tables are one policy split by what each layer can enforce. A
  // resolution row no pipeline row names would be a contract with no pipeline
  // — reachable only by a caller that bypassed this table.
  const named = new Set(
    Object.values(SELECTOR_PIPELINE_POLICIES).map((policy) => policy.resolution),
  );
  for (const [name, resolution] of Object.entries(SELECTOR_RESOLUTION_POLICIES)) {
    assert.ok(named.has(resolution), `${name} is not consumed by any pipeline row`);
  }
});

test('the documented per-caller pipelines are the ones declared', () => {
  assert.deepEqual(
    Object.fromEntries(
      Object.entries(SELECTOR_PIPELINE_POLICIES).map(([name, policy]) => [
        name,
        [
          policy.occlusion,
          policy.offscreen,
          policy.promotion,
          policy.poll === 'none' ? 'no-poll' : 'poll',
        ],
      ]),
    ),
    {
      promotedTarget: ['exclude-and-refuse', 'refuse', 'hittable-ancestor', 'no-poll'],
      resolvedTarget: ['exclude-and-refuse', 'refuse', 'none', 'no-poll'],
      coveredDiagnosis: ['refuse', 'ignore', 'none', 'no-poll'],
      readText: ['ignore', 'ignore', 'none', 'no-poll'],
      readUnique: ['ignore', 'ignore', 'none', 'no-poll'],
      readAny: ['ignore', 'ignore', 'none', 'no-poll'],
      findWait: ['ignore', 'ignore', 'none', 'poll'],
      wait: ['ignore', 'ignore', 'none', 'poll'],
      findAct: ['refuse', 'ignore', 'hittable-ancestor-below-root', 'no-poll'],
    },
  );
});
