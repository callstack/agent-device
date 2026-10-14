import assert from 'node:assert/strict';
import { test } from 'vitest';
import type {
  RawSnapshotNode,
  SnapshotAddressableNode,
  SnapshotNode,
} from '@agent-device/kernel/snapshot';
import { SELECTOR_RESOLUTION_POLICIES } from '@agent-device/selectors';
import { makeSnapshotState } from './snapshot-geometry.fixtures.ts';
import {
  ELEMENT14_DISTINCT_SUBTREE_NODES,
  RN_TEXT_ECHO_AUTHORED_CHILD_NODES,
  RN_TEXT_ECHO_DISTINCT_SUBTREE_NODES,
  RN_TEXT_ECHO_NODES,
  RN_TEXT_ECHO_OFFSET_RECT_NODES,
  TWO_ACTIONABLE_WRAPPER_CHAIN_NODES,
  UNVERIFIED_HITTABILITY_WRAPPER_CHAIN_NODES,
} from './interaction-targeting.fixtures.ts';
import {
  listSelectorPipelineMatches,
  resolveActionSelectorPipeline,
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
  'cropTarget',
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
    depth: 1,
    parentIndex: 2,
    type: 'XCUIElementTypeCell',
    label: 'Account row',
    rect: { x: 10, y: 20, width: 300, height: 60 },
    hittable: true,
  },
  {
    index: 1,
    depth: 2,
    parentIndex: 0,
    type: 'XCUIElementTypeStaticText',
    label: 'Account',
    rect: { x: 24, y: 32, width: 80, height: 20 },
    hittable: false,
  },
  {
    index: 2,
    depth: 0,
    type: 'XCUIElementTypeApplication',
    rect: { x: 0, y: 0, width: 390, height: 844 },
    hittable: true,
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

const REFLESS_RECT_TREE: SnapshotNode[] = [
  {
    index: 0,
    depth: 0,
    type: 'XCUIElementTypeButton',
    label: 'Addressless',
    rect: { x: 20, y: 30, width: 100, height: 40 },
    hittable: true,
    kind: 'button',
  },
];

const REFLESS_PROMOTION_TREE: SnapshotNode[] = [
  {
    index: 0,
    depth: 0,
    type: 'XCUIElementTypeApplication',
    rect: { x: 0, y: 0, width: 390, height: 844 },
    hittable: true,
    kind: 'application',
    ref: 'e1',
  },
  {
    index: 1,
    depth: 1,
    parentIndex: 0,
    type: 'XCUIElementTypeCell',
    label: 'Addressless Row',
    rect: { x: 20, y: 30, width: 180, height: 50 },
    hittable: true,
    kind: 'cell',
  },
  {
    index: 2,
    depth: 2,
    parentIndex: 1,
    type: 'XCUIElementTypeStaticText',
    label: 'Addressless Row',
    rect: { x: 30, y: 40, width: 120, height: 20 },
    hittable: false,
    kind: 'text',
    ref: 'e3',
  },
];

const REFLESS_STRUCTURAL_ANCESTOR_TREE: SnapshotNode[] = [
  {
    index: 0,
    depth: 0,
    type: 'XCUIElementTypeApplication',
    rect: { x: 0, y: 0, width: 390, height: 844 },
    kind: 'application',
    ref: 'e1',
  },
  {
    index: 1,
    depth: 1,
    parentIndex: 0,
    type: 'XCUIElementTypeOther',
    identifier: 'bridged-control',
    rect: { x: 20, y: 30, width: 36, height: 36 },
    kind: 'other',
    ref: 'e2',
  },
  {
    index: 2,
    depth: 2,
    parentIndex: 1,
    type: 'XCUIElementTypeOther',
    rect: { x: 20, y: 30, width: 36, height: 36 },
    kind: 'other',
  },
  {
    index: 3,
    depth: 3,
    parentIndex: 2,
    type: 'XCUIElementTypeButton',
    identifier: 'bridged-control',
    rect: { x: 20, y: 30, width: 36, height: 36 },
    kind: 'button',
    ref: 'e4',
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
  for (const row of [
    'readText',
    'readUnique',
    'readAny',
    'wait',
    'findWait',
    'cropTarget',
  ] as const) {
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
  for (const row of [
    'readText',
    'readUnique',
    'readAny',
    'wait',
    'findWait',
    'cropTarget',
  ] as const) {
    const target = await stagedIndex(row, COVERED_TREE, 1);
    assert.equal(target.kind, 'target', row);
    assert.equal(target.node.index, 1, row);
  }
});

test('the promotion stage retargets only for the rows that declare it', async () => {
  // Same tree, same node: the row is the whole difference.
  assert.equal((await stagedIndex('promotedTarget', PROMOTABLE_TREE, 1)).node.index, 0);
  assert.equal((await stagedIndex('findAct', PROMOTABLE_TREE, 1)).node.index, 0);
  for (const row of [
    'resolvedTarget',
    'readText',
    'readUnique',
    'readAny',
    'wait',
    'cropTarget',
  ] as const) {
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

/** Captured from a live simulator: one SwiftUI toolbar button reported twice. */
const WRAPPER_CHAIN_TREE = UNVERIFIED_HITTABILITY_WRAPPER_CHAIN_NODES;
const WRAPPER_CHAIN_SELECTOR = 'id="scoring_home_button"';

test('the uniqueness rows collapse one control reported through its own wrapper', async () => {
  const nodes = nodesOf(WRAPPER_CHAIN_TREE);
  for (const row of ['readUnique', 'cropTarget'] as const) {
    const outcome = await resolveSelectorPipeline(
      SELECTOR_PIPELINE_POLICIES[row],
      nodes,
      WRAPPER_CHAIN_SELECTOR,
      MATCH,
    );
    assert.equal(outcome.kind, 'target', row);
    if (outcome.kind !== 'target') continue;
    assert.equal(outcome.node.type, 'XCUIElementTypeButton', row);
    assert.equal(outcome.selector, WRAPPER_CHAIN_SELECTOR, row);
    // The refused candidate set survives the collapse: the answer is about one
    // control, and the read still reports that it matched twice.
    assert.equal(outcome.matches, 2, row);
    assert.deepEqual(
      outcome.matchedNodes.map((node) => node.type),
      ['XCUIElementTypeOther', 'XCUIElementTypeButton'],
      row,
    );
  }
});

test('a row that resolves on its own keeps its own answer on a wrapper chain', async () => {
  const nodes = nodesOf(WRAPPER_CHAIN_TREE);
  // `wait`/`is exists` take the document-order head, which is the wrapper: the
  // question is presence, and this row never reaches the collapse.
  for (const row of ['readAny', 'wait'] as const) {
    const outcome = await resolveSelectorPipeline(
      SELECTOR_PIPELINE_POLICIES[row],
      nodes,
      WRAPPER_CHAIN_SELECTOR,
      MATCH,
    );
    assert.equal(outcome.kind, 'target', row);
    if (outcome.kind === 'target') assert.equal(outcome.node.index, 0, row);
  }
  // `get text` ranks visible→deepest→smallest-area, and depth separates a
  // wrapper from its control, so the tiebreak already answers the control.
  const readText = await resolveSelectorPipeline(
    SELECTOR_PIPELINE_POLICIES.readText,
    nodes,
    WRAPPER_CHAIN_SELECTOR,
    MATCH,
  );
  assert.equal(readText.kind, 'target');
  if (readText.kind === 'target') assert.equal(readText.node.index, 1);
});

test('the uniqueness rows still refuse matches that are not one wrapper chain', async () => {
  const cases = [
    ['two actionable controls', nodesOf(TWO_ACTIONABLE_WRAPPER_CHAIN_NODES), 'id="profile"'],
    ['distinct subtrees', nodesOf(ELEMENT14_DISTINCT_SUBTREE_NODES), 'label="Team Standup"'],
  ] as const;
  for (const [name, nodes, selector] of cases) {
    for (const row of ['readUnique', 'cropTarget'] as const) {
      const outcome = await resolveSelectorPipeline(
        SELECTOR_PIPELINE_POLICIES[row],
        nodes,
        selector,
        MATCH,
      );
      assert.equal(outcome.kind, 'ambiguous', `${name} / ${row}`);
    }
  }
});

/**
 * #2870: React Native reports one authored `<Text>` twice on a regular iOS
 * snapshot — the paragraph view plus its accessibility-element child, identical
 * label, identical rect, both carrying a hittability fact (which is why the
 * hittability-door wrapper rule above cannot reach this pair). The uniqueness rows
 * answer about the reporter: the node `snapshot -i` lists and the node whose
 * testID an `id=` selector names.
 */
const RN_TEXT_ECHO_TREE = RN_TEXT_ECHO_NODES;
const RN_TEXT_ECHO_SELECTOR = 'label="Catalog scroll: top"';

test('the uniqueness rows collapse React Native text reported twice', async () => {
  const nodes = nodesOf(RN_TEXT_ECHO_TREE);
  for (const row of ['readUnique', 'cropTarget'] as const) {
    const outcome = await resolveSelectorPipeline(
      SELECTOR_PIPELINE_POLICIES[row],
      nodes,
      RN_TEXT_ECHO_SELECTOR,
      MATCH,
    );
    assert.equal(outcome.kind, 'target', row);
    if (outcome.kind !== 'target') continue;
    // The outer reporter keeps the identifier the app authored; the mirror adds no fact.
    assert.equal(outcome.node.index, 0, row);
    assert.equal(outcome.node.identifier, 'catalog-scroll-state', row);
    assert.equal(outcome.matches, 2, row);
    assert.deepEqual(
      outcome.matchedNodes.map((node) => node.role),
      ['RCTParagraphComponentView', 'RCTAccessibilityElement'],
      row,
    );
  }
});

/**
 * Each negative changes exactly ONE structural fact of the pair above while every
 * label and rect still matches (or the ancestry breaks), so a rule reading the
 * description rather than the structure would answer and these tests would notice.
 */
test('the uniqueness rows refuse a text pair that is not one reporter and its mirror', async () => {
  const cases = [
    [
      'same label in distinct subtrees',
      nodesOf(RN_TEXT_ECHO_DISTINCT_SUBTREE_NODES),
      RN_TEXT_ECHO_SELECTOR,
    ],
    [
      'same label repeated at a different rect',
      nodesOf(RN_TEXT_ECHO_OFFSET_RECT_NODES),
      RN_TEXT_ECHO_SELECTOR,
    ],
    [
      // Same label AND same frame — the case geometry cannot decide. The
      // descendant is authored (view-backed roles), not the platform's
      // reported accessibility element, so the pair stays two elements.
      'same label at the same frame with an authored descendant',
      nodesOf(RN_TEXT_ECHO_AUTHORED_CHILD_NODES),
      RN_TEXT_ECHO_SELECTOR,
    ],
  ] as const;
  for (const [name, nodes, selector] of cases) {
    for (const row of ['readUnique', 'cropTarget'] as const) {
      const outcome = await resolveSelectorPipeline(
        SELECTOR_PIPELINE_POLICIES[row],
        nodes,
        selector,
        MATCH,
      );
      assert.equal(outcome.kind, 'ambiguous', `${name} / ${row}`);
    }
  }
});

/**
 * The absence negative, whose outcome a collapsed read must never be confused
 * with: the selector that matches nothing is `none`, and it stays `none` even
 * where a collapse-capable tree is one label away from matching.
 */
test('a selector matching nothing on the text-echo tree resolves to none, not a collapse', async () => {
  const nodes = nodesOf(RN_TEXT_ECHO_TREE);
  for (const row of ['readUnique', 'cropTarget'] as const) {
    const outcome = await resolveSelectorPipeline(
      SELECTOR_PIPELINE_POLICIES[row],
      nodes,
      'label="Catalog scroll: bottom"',
      MATCH,
    );
    assert.equal(outcome.kind, 'none', row);
  }
});

test('the poll stage answers only for the rows that poll a caller-default budget', () => {
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

  // Both locals are the same production object, so `nodeStages && pollBudget` could only
  // restate it. The runtime half of the claim lives in "pipeline rows declare only the
  // stages their kind enforces" below, which pins `readList`'s key set exhaustively.
  void [nodeStages, pollBudget];
});

test('rect-requiring pipeline entries narrow outcome nodes to addressable nodes', async () => {
  const nodes = nodesOf(PROMOTABLE_TREE);
  const staged = await runNodePipelineStages(
    SELECTOR_PIPELINE_POLICIES.promotedTarget,
    nodes,
    nodes[0]!,
    { offscreen: async (node) => node },
  );
  const stagedAddressable: SnapshotAddressableNode = staged.node;
  const stagedRef: string = staged.node.ref;

  const resolved = await resolveSelectorPipeline(
    SELECTOR_PIPELINE_POLICIES.coveredDiagnosis,
    nodes,
    'label="Account"',
    MATCH,
  );
  if (resolved.kind === 'target') {
    const resolvedAddressable: SnapshotAddressableNode = resolved.node;
    const resolvedRef: string = resolved.node.ref;
    void [resolvedAddressable, resolvedRef];
  }

  const listed = listSelectorPipelineMatches(
    SELECTOR_PIPELINE_POLICIES.findAct,
    nodes,
    'label="Account"',
    MATCH,
  );
  const listedAddressable: SnapshotAddressableNode = listed.list!.matchedNodes[0]!;
  const listedRef: string = listed.list!.matchedNodes[0]!.ref;

  const action = resolveActionSelectorPipeline(
    SELECTOR_PIPELINE_POLICIES.promotedTarget,
    nodes,
    'label="Account"',
    MATCH,
  );
  if (action.kind === 'resolved') {
    const actionAddressable: SnapshotAddressableNode = action.resolution.node;
    const actionRef: string = action.resolution.node.ref;
    void [actionAddressable, actionRef];
  }

  const read = await runNodePipelineStages(SELECTOR_PIPELINE_POLICIES.readAny, nodes, nodes[0]!);
  // @ts-expect-error read rows do not prove that a selectable node is addressable.
  const readRef: string = read.node.ref;

  const readList = listSelectorPipelineMatches(
    SELECTOR_PIPELINE_POLICIES.readList,
    nodes,
    'label="Account"',
    MATCH,
  );
  // @ts-expect-error listing rows without rect requirements do not prove addressability.
  const readListRef: string = readList.list!.matchedNodes[0]!.ref;
  void [stagedAddressable, stagedRef, listedAddressable, listedRef, readRef, readListRef];
});

test('rect-requiring pipeline entries do not expose ref-less rect nodes as addressable', async () => {
  const listed = listSelectorPipelineMatches(
    SELECTOR_PIPELINE_POLICIES.findAct,
    REFLESS_RECT_TREE,
    'label="Addressless"',
    MATCH,
  );
  assert.equal(listed.list, null);

  const resolved = await resolveSelectorPipeline(
    SELECTOR_PIPELINE_POLICIES.coveredDiagnosis,
    REFLESS_RECT_TREE,
    'label="Addressless"',
    MATCH,
  );
  assert.equal(resolved.kind, 'none');

  const read = await resolveSelectorPipeline(
    SELECTOR_PIPELINE_POLICIES.readAny,
    REFLESS_RECT_TREE,
    'label="Addressless"',
    MATCH,
  );
  assert.equal(read.kind, 'target');
  if (read.kind === 'target') assert.equal(read.node.ref, undefined);

  const action = resolveActionSelectorPipeline(
    SELECTOR_PIPELINE_POLICIES.promotedTarget,
    REFLESS_RECT_TREE,
    'label="Addressless"',
    MATCH,
  );
  assert.equal(action.kind, 'none');
});

test('acting selector classification keeps full ancestry after candidate addressability filtering', () => {
  const action = resolveActionSelectorPipeline(
    SELECTOR_PIPELINE_POLICIES.promotedTarget,
    REFLESS_STRUCTURAL_ANCESTOR_TREE,
    'id="bridged-control"',
    MATCH,
  );
  assert.equal(action.kind, 'resolved');
  if (action.kind !== 'resolved') return;
  assert.equal(action.resolution.node.index, 3);
  assert.equal(action.resolution.matches, 2);
  assert.equal(action.resolution.disambiguation?.tiebreak, 'structural-equivalence');
});

test('rect-requiring node stages fail closed if promotion lands on a ref-less node', async () => {
  await assert.rejects(
    () =>
      runNodePipelineStages(
        SELECTOR_PIPELINE_POLICIES.resolvedTarget,
        REFLESS_RECT_TREE,
        REFLESS_RECT_TREE[0]!,
        { offscreen: async (node) => node },
      ),
    /requires an addressable target/,
  );

  await assert.rejects(
    () =>
      runNodePipelineStages(
        SELECTOR_PIPELINE_POLICIES.promotedTarget,
        REFLESS_PROMOTION_TREE,
        REFLESS_PROMOTION_TREE[2]!,
        { offscreen: async (node) => node },
      ),
    /requires an addressable target/,
  );
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
      cropTarget: ['ignore', 'ignore', 'none', 'no-poll'],
    },
  );
});
