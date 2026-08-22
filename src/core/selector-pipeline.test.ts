import assert from 'node:assert/strict';
import { test } from 'vitest';
import type { RawSnapshotNode, SnapshotNode } from '@agent-device/kernel/snapshot';
import { SELECTOR_RESOLUTION_POLICIES } from '@agent-device/selectors';
import { makeSnapshotState } from '../__tests__/test-utils/snapshot-builders.ts';
import {
  listSelectorPipelineMatches,
  resolveSelectorPipeline,
  runNodePipelineStages,
  selectorPollBudget,
} from './selector-pipeline.ts';
import { SELECTOR_PIPELINE_POLICIES } from './selector-pipeline-policy.ts';

/**
 * Rows whose result is ONE target. The listing row is absent by TYPE, not by
 * omission: it declares no node stages, so the entries below cannot take it.
 */
const NODE_STAGE_ROWS = [
  'promotedTarget',
  'resolvedTarget',
  'coveredDiagnosis',
  'readText',
  'readUnique',
  'readAny',
  'findWait',
  'wait',
  'findAct',
] as const;

/**
 * The owner's own contract: that it runs what a row declares, for every row.
 * Whether a given COMMAND runs the row is proven where it can actually be
 * falsified — against `get`/`is`/`wait`/`find` in
 * commands/interaction/runtime/__tests__/selector-read-policy.test.ts and
 * resolution.test.ts. Neither file alone is enough: this one would pass on a
 * pipeline nothing calls, those would pass on a pipeline that ignores its row.
 */

const MATCH = { platform: 'ios' as const };

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

function nodesOf(raw: RawSnapshotNode[]): SnapshotNode[] {
  return makeSnapshotState(raw).nodes;
}

async function stagedIndex(
  row: (typeof NODE_STAGE_ROWS)[number],
  raw: RawSnapshotNode[],
  index: number,
) {
  const nodes = nodesOf(raw);
  const policy = SELECTOR_PIPELINE_POLICIES[row];
  const target = await runNodePipelineStages(policy, nodes, nodes[index]!, {
    // Supplied for every row; only rows whose off-screen stage refuses reach it.
    offscreen: async (node) => node,
  });
  return target;
}

test('the occlusion stage decides candidacy: acting rows drop covered nodes, the rest keep them', async () => {
  const nodes = nodesOf(COVERED_TREE);
  for (const row of ['promotedTarget', 'resolvedTarget'] as const) {
    const listed = listSelectorPipelineMatches(
      SELECTOR_PIPELINE_POLICIES[row],
      nodes,
      'label="Save"',
      MATCH,
    );
    assert.equal(listed.list, null, row);
  }
  for (const row of ['findAct', 'readList'] as const) {
    const listed = listSelectorPipelineMatches(
      SELECTOR_PIPELINE_POLICIES[row],
      nodes,
      'label="Save"',
      MATCH,
    );
    assert.equal(listed.list?.matchedNodes.length, 1, row);
  }
  for (const row of ['readText', 'readUnique', 'readAny', 'wait', 'findWait'] as const) {
    const outcome = await resolveSelectorPipeline(
      SELECTOR_PIPELINE_POLICIES[row],
      nodes,
      'label="Save"',
      MATCH,
    );
    assert.equal(outcome.kind, 'target', row);
  }
});

test('the occlusion stage decides refusal: every row that refuses a covered target, and every row that does not', async () => {
  for (const row of ['promotedTarget', 'resolvedTarget', 'findAct', 'coveredDiagnosis'] as const) {
    const target = await stagedIndex(row, COVERED_TREE, 1);
    assert.equal(target.kind, 'occluded', row);
    assert.equal(target.node.index, 1, row);
  }
  // `readList` is absent by construction: a listing row declares no node
  // stages, so it has no occlusion verdict to make on a target.
  for (const row of ['readText', 'readUnique', 'readAny', 'wait', 'findWait'] as const) {
    const target = await stagedIndex(row, COVERED_TREE, 1);
    assert.equal(target.kind, 'target', row);
    assert.equal(target.node.index, 1, row);
  }
});

test('the promotion stage retargets only for the rows that declare it', async () => {
  // Same tree, same node: the row is the whole difference.
  assert.equal((await stagedIndex('promotedTarget', PROMOTABLE_TREE, 1)).node.index, 0);
  assert.equal((await stagedIndex('findAct', PROMOTABLE_TREE, 1)).node.index, 0);
  for (const row of ['resolvedTarget', 'readText', 'readUnique', 'readAny', 'wait'] as const) {
    assert.equal((await stagedIndex(row, PROMOTABLE_TREE, 1)).node.index, 1, row);
  }
});

test('find’s promotion stops below the viewport root; the tap row does not', async () => {
  // `find` ranks matches across the whole tree, so a promotion that lands on
  // the root container would turn "the thing that matched" into "the screen".
  assert.equal((await stagedIndex('promotedTarget', ROOT_ANCESTOR_TREE, 1)).node.index, 0);
  assert.equal((await stagedIndex('findAct', ROOT_ANCESTOR_TREE, 1)).node.index, 1);
});

test('the off-screen stage runs the refusal shape only for the rows that refuse', async () => {
  const nodes = nodesOf(PROMOTABLE_TREE);
  for (const row of NODE_STAGE_ROWS) {
    let consulted = false;
    await runNodePipelineStages(SELECTOR_PIPELINE_POLICIES[row], nodes, nodes[0]!, {
      offscreen: async (node) => {
        consulted = true;
        return node;
      },
    });
    const refuses = SELECTOR_PIPELINE_POLICIES[row].offscreen === 'refuse';
    assert.equal(consulted, refuses, row);
  }
});

test('a row that refuses off-screen without a refusal shape fails loudly', async () => {
  // What a flipped observation row hits on its real route: the row declares a
  // refusal the route has no error to express, and that is a bug, not a
  // silently skipped stage.
  const nodes = nodesOf(PROMOTABLE_TREE);
  await assert.rejects(
    () => runNodePipelineStages(SELECTOR_PIPELINE_POLICIES.promotedTarget, nodes, nodes[0]!),
    /supplies no refusal shape/,
  );
});

test('the poll stage answers only for the rows that poll', () => {
  for (const row of ['wait', 'findWait'] as const) {
    assert.deepEqual(selectorPollBudget(SELECTOR_PIPELINE_POLICIES[row]), {
      defaultTimeoutMs: 10_000,
      intervalMs: 300,
    });
  }
  for (const row of NODE_STAGE_ROWS.filter((name) => name !== 'wait' && name !== 'findWait')) {
    assert.throws(() => selectorPollBudget(SELECTOR_PIPELINE_POLICIES[row]), /no poll budget/, row);
  }
});

test('a listing row cannot be handed the node stages it does not declare', () => {
  // The `@ts-expect-error` directives ARE the assertion: a listing has no
  // single target to retarget, keep on screen, or wait for, so widening
  // `readList` to declare one of those stages makes these calls legal, leaves
  // the directives unused, and fails the typecheck. Type-level rather than
  // executed, because the point is that these entries never accept the row.

  // @ts-expect-error a listing row declares no promotion or off-screen stage.
  const nodeStages: Parameters<typeof runNodePipelineStages>[0] =
    SELECTOR_PIPELINE_POLICIES.readList;
  // @ts-expect-error a listing row declares no poll budget to ask for.
  const pollBudget: Parameters<typeof selectorPollBudget>[0] = SELECTOR_PIPELINE_POLICIES.readList;

  // The runtime half of the same claim, so the row cannot grow a node stage
  // while the directives are updated to match.
  assert.deepEqual(
    Object.keys(SELECTOR_PIPELINE_POLICIES.readList).filter((stage) =>
      ['promotion', 'offscreen', 'poll'].includes(stage),
    ),
    [],
  );
  assert.ok(nodeStages && pollBudget);
});

test('pipeline rows declare only the stages their kind enforces', () => {
  // The #1649 rule, carried to this table: a column nothing consumes is an
  // unverifiable claim that reads as truth. A row declares the stages ITS KIND
  // can run — a listing row that grew a `promotion` cell would be claiming a
  // stage no listing flow executes, which is the same disease one level down.
  const TARGET_ROW_STAGES = ['occlusion', 'offscreen', 'poll', 'promotion', 'resolution'];
  const LIST_ROW_STAGES = ['occlusion', 'resolution'];
  for (const [name, policy] of Object.entries(SELECTOR_PIPELINE_POLICIES)) {
    const declared = Object.keys(policy).sort();
    const expected = name === 'readList' ? LIST_ROW_STAGES : TARGET_ROW_STAGES;
    assert.deepEqual(declared, expected, `${name} declares a stage its kind cannot run`);
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
      NODE_STAGE_ROWS.map((name) => {
        const policy = SELECTOR_PIPELINE_POLICIES[name];
        return [
          name,
          [
            policy.occlusion,
            policy.offscreen,
            policy.promotion,
            policy.poll === 'none' ? 'no-poll' : 'poll',
          ],
        ];
      }),
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
