import assert from 'node:assert/strict';
import { test } from 'vitest';
import type {
  IosSnapshotAcquisition,
  IosSnapshotEngine,
  IosSnapshotInput,
  IosSnapshotRequest,
  IosSnapshotValidationFacts,
} from '@agent-device/contracts/ios-snapshot';
import {
  buildIosSnapshotPresentationKey,
  createIosSnapshotRequest,
  deriveIosCaptureHint,
} from '@agent-device/capture-kit/ios-snapshot-planning';
import { toIosSnapshotEngineErrorDetails } from './types.ts';
import {
  IosSnapshotEngineError,
  buildIosInteractiveSnapshotPresentation,
  presentIosSnapshot,
  publishIosSnapshot,
} from './index.ts';
import { resolveIosViewportEvidenceFromRoots } from '@agent-device/capture-kit/ios-snapshot-acquisition';
import type { Rect, RawSnapshotNode } from '@agent-device/kernel/snapshot';

const viewport: Rect = { x: 0, y: 0, width: 320, height: 240 };

test('regular presentation folds nested clips and keeps effective actionability', () => {
  const request = createIosSnapshotRequest();
  const result = publishIosSnapshot(acquiredInput(request, nestedNodes()), request);

  assert.deepEqual(
    result.payload.nodes.map((node) => [node.label, node.rect, node.parentIndex]),
    [
      ['App', viewport, undefined],
      ['Outer', { x: 16, y: 20, width: 180, height: 180 }, 0],
      ['Inner', { x: 120, y: 40, width: 76, height: 160 }, 1],
      ['Partially visible', { x: 150, y: 80, width: 46, height: 40 }, 2],
    ],
  );
  assert.equal(result.payload.nodes[3]?.hittable, true);
  assert.equal(result.payload.nodes[3]?.ref, 'e4');
  assert.equal(result.comparisonIdentity.lineage.targetId, 'simulator-1');
});

test('raw projection preserves reported geometry while regular projection clips it', () => {
  const regularRequest = createIosSnapshotRequest();
  const rawRequest = createIosSnapshotRequest({ raw: true, interactiveOnly: true });
  const nodes = nestedNodes();
  const regular = publishIosSnapshot(acquiredInput(regularRequest, nodes), regularRequest);
  const raw = publishIosSnapshot(acquiredInput(rawRequest, nodes), rawRequest);

  assert.equal(
    regular.payload.nodes.some((node) => node.label === 'Escaped child'),
    false,
  );
  assert.equal(raw.payload.nodes.find((node) => node.label === 'Escaped child')?.rect?.x, 210);
  assert.equal(raw.payload.nodes.find((node) => node.label === 'Escaped child')?.hittable, true);
});

test('presentation mapping retains acquisition lineage through projection and scoped reindexing', () => {
  const nodes: RawSnapshotNode[] = [
    node(10, 'Application', 'App', viewport),
    node(20, 'Other', undefined, viewport, 10, 1),
    node(40, 'Button', 'Target', { x: 20, y: 20, width: 80, height: 40 }, 20, 2),
  ];
  const regularRequest = createIosSnapshotRequest();
  const regular = presentIosSnapshot(acquiredInput(regularRequest, nodes), regularRequest);

  assert.deepEqual(
    [...regular.presentedIndexesBySourceIndex],
    [
      [10, [0]],
      [20, []],
      [40, [1]],
    ],
  );

  const rawRequest = createIosSnapshotRequest({ raw: true, scope: 'Target' });
  const rawNodes = [
    node(10, 'Application', 'App', viewport),
    node(20, 'Other', 'Target', viewport, 10, 1),
    node(40, 'Button', 'Child', { x: 20, y: 20, width: 80, height: 40 }, 20, 2),
  ];
  const raw = presentIosSnapshot(acquiredInput(rawRequest, rawNodes), rawRequest);

  assert.deepEqual(
    [...raw.presentedIndexesBySourceIndex],
    [
      [10, []],
      [20, [0]],
      [40, [1]],
    ],
  );
});

test('raw scoped depth derives missing source depths from parent order', () => {
  const request = createIosSnapshotRequest({ raw: true, scope: 'Target', depth: 1 });
  const nodes: RawSnapshotNode[] = [
    node(10, 'Application', 'App', viewport),
    { ...node(20, 'Other', 'Target', viewport, 10), depth: undefined },
    {
      ...node(40, 'Button', 'Child', { x: 20, y: 20, width: 80, height: 40 }, 20),
      depth: undefined,
    },
    {
      ...node(50, 'Button', 'Grandchild', { x: 24, y: 24, width: 60, height: 32 }, 40),
      depth: undefined,
    },
  ];
  const result = presentIosSnapshot(acquiredInput(request, nodes), request);

  assert.deepEqual(
    result.nodes.map((entry) => entry.label),
    ['Target', 'Child'],
  );
});

test('cursor projection keeps geometryless nodes neutral while plain viewport keeps child visibility independent', () => {
  const request = createIosSnapshotRequest();
  const nodes = [
    node(0, 'Application', 'App', viewport),
    { ...node(1, 'Other', 'No frame', viewport, 0, 1), rect: undefined },
    node(2, 'Button', 'Child', { x: 20, y: 20, width: 40, height: 40 }, 1, 2),
  ];
  const cursor = publishIosSnapshot(acquiredInput(request, nodes), request);
  const plain = publishIosSnapshot(acquiredInput(request, nodes), request, {
    foldPolicy: 'plain-viewport',
  });

  assert.deepEqual(
    cursor.payload.nodes.map((entry) => entry.label),
    ['App', 'No frame', 'Child'],
  );
  assert.deepEqual(
    plain.payload.nodes.map((entry) => entry.label),
    ['App', 'Child'],
  );
});

test('scope reparents wrappers and regular depth counts presented nodes', () => {
  const request = createIosSnapshotRequest({ scope: 'Target', depth: 1 });
  const result = publishIosSnapshot(acquiredInput(request, scopedNodes()), request);

  assert.deepEqual(
    result.payload.nodes.map((node) => [node.type, node.label, node.depth, node.parentIndex]),
    [
      ['Other', 'Target', 0, undefined],
      ['Button', 'Target', 1, 0],
    ],
  );
});

test('plain viewport policy does not inherit cursor clipping', () => {
  const request = createIosSnapshotRequest();
  const result = publishIosSnapshot(
    acquiredInput(request, [
      node(0, 'Application', 'App', viewport),
      node(1, 'ScrollView', 'Scroll', { x: 0, y: 100, width: 320, height: 40 }, 0),
      node(2, 'StaticText', 'Outside scroll clip', { x: 10, y: 200, width: 80, height: 20 }, 1),
    ]),
    request,
    { foldPolicy: 'plain-viewport' },
  );

  assert.deepEqual(
    result.payload.nodes.map((entry) => entry.label),
    ['App', 'Scroll', 'Outside scroll clip'],
  );
});

test('regular presentation fails typed when the viewport is missing or the graph is malformed', () => {
  const request = createIosSnapshotRequest();
  const missingViewport: IosSnapshotAcquisition = {
    ...acquisition(request, nestedNodes()),
    viewport: { kind: 'missing', reason: 'not-provided' },
  };
  assert.throws(
    () => publishIosSnapshot({ stage: 'acquired', acquisition: missingViewport }, request),
    (error: unknown) =>
      error instanceof IosSnapshotEngineError && error.reason === 'missing-viewport',
  );

  const malformed = acquisition(request, [
    node(0, 'Application', 'App', viewport),
    { ...node(1, 'Button', 'Broken', { x: 1, y: 1, width: 10, height: 10 }, 0), parentIndex: 99 },
  ]);
  assert.throws(
    () => publishIosSnapshot({ stage: 'acquired', acquisition: malformed }, request),
    (error: unknown) =>
      error instanceof IosSnapshotEngineError && error.reason === 'malformed-graph',
  );
});

test('engine error details preserve typed public context', () => {
  const error = new IosSnapshotEngineError('invalid-viewport', 'invalid viewport', {
    field: 'viewport',
    index: 4,
    parentIndex: 2,
    frame: { x: 0, y: 0, width: 10, height: 10 },
    clip: { x: 1, y: 2, width: 3, height: 4 },
    projection: 'regular',
  });

  assert.deepEqual(toIosSnapshotEngineErrorDetails(error), {
    reason: 'invalid-viewport',
    field: 'viewport',
    index: 4,
    parentIndex: 2,
    frame: { x: 0, y: 0, width: 10, height: 10 },
    clip: { x: 1, y: 2, width: 3, height: 4 },
    projection: 'regular',
  });
});

test('viewport evidence prefers reported application and window roots', () => {
  assert.deepEqual(
    resolveIosViewportEvidenceFromRoots([
      { type: 'XCUIElementTypeApplication', rectStatus: 'invalid' },
      {
        type: 'XCUIElementTypeWindow',
        rect: { x: 0, y: 0, width: 390, height: 844 },
        rectStatus: 'reported',
      },
    ]),
    { kind: 'reported', rect: { x: 0, y: 0, width: 390, height: 844 } },
  );
});

test('viewport evidence can fall back to the largest top-level root', () => {
  assert.deepEqual(
    resolveIosViewportEvidenceFromRoots(
      [
        { type: 'Other', rect: { x: 0, y: 0, width: 100, height: 100 } },
        { type: 'Other', rect: { x: 0, y: 0, width: 200, height: 300 } },
      ],
      { fallbackToLargestRoot: true },
    ),
    { kind: 'reported', rect: { x: 0, y: 0, width: 200, height: 300 } },
  );
});

test('viewport evidence preserves explicit missing geometry reasons', () => {
  assert.deepEqual(
    resolveIosViewportEvidenceFromRoots([{ type: 'Application', rectStatus: 'invalid' }]),
    { kind: 'missing', reason: 'invalid' },
  );
  assert.deepEqual(
    resolveIosViewportEvidenceFromRoots([{ type: 'Application', rectStatus: 'not-provided' }]),
    { kind: 'missing', reason: 'not-provided' },
  );
});

test('presented runner payloads and optional quality payloads cross the host invariant', () => {
  const request = createIosSnapshotRequest();
  const presentedCapture = publishIosSnapshot(acquiredInput(request, nestedNodes()), request);
  const input: IosSnapshotInput = {
    stage: 'presented',
    presentation: {
      producer: 'apple-runner',
      intent: 'full',
      payload: { nodes: presentedCapture.payload.nodes, truncated: false },
      qualityPayload: {
        nodes: presentedCapture.payload.nodes,
        truncated: false,
        scope: null,
      },
    },
    validation: validationFacts(request),
  };
  const result = publishIosSnapshot(input, request);

  assert.equal(result.payload.nodes.length, 4);
  assert.equal(result.payload.nodes[3]?.ref, 'e4');
  assert.equal(result.residue.length, 1);
});

test('scoped raw presentation retains an unscoped quality view', () => {
  const request = createIosSnapshotRequest({ raw: true, scope: 'Target' });
  const result = presentIosSnapshot(acquiredInput(request, scopedNodes()), request);

  assert.deepEqual(
    result.nodes.map((entry) => entry.label),
    ['Target', 'Target'],
  );
  assert.deepEqual(
    result.qualityNodes?.map((entry) => entry.label),
    ['App', 'Wrapper', 'Target', 'Target'],
  );
});

test('unavailable hittability never becomes regular actionability', () => {
  const request = createIosSnapshotRequest();
  const unavailable = {
    ...acquisition(request, nestedNodes()),
    residue: [{ kind: 'unavailable-fact' as const, fact: 'hittability' as const }],
  } satisfies IosSnapshotAcquisition;
  const acquired = publishIosSnapshot({ stage: 'acquired', acquisition: unavailable }, request);
  const partiallyVisible = acquired.payload.nodes.find(
    (node) => node.label === 'Partially visible',
  );
  assert.ok(partiallyVisible);
  assert.equal(partiallyVisible.hittable, undefined);
  assert.equal('hittable' in partiallyVisible, false);

  const available = publishIosSnapshot(acquiredInput(request, nestedNodes()), request);
  const presented: IosSnapshotInput = {
    stage: 'presented',
    presentation: {
      producer: 'apple-runner',
      intent: 'full',
      payload: { nodes: available.payload.nodes, truncated: false },
    },
    validation: {
      ...validationFacts(request),
      hittability: { kind: 'unavailable', reason: 'not-provided' },
    },
  };
  assert.throws(
    () => publishIosSnapshot(presented, request),
    (error: unknown) =>
      error instanceof IosSnapshotEngineError &&
      error.code === 'IOS_SNAPSHOT_ENGINE_FAILED' &&
      error.reason === 'invalid-presented-payload',
  );
});

test('a source-declared disabled node is not actionable without hittability evidence', () => {
  const request = createIosSnapshotRequest();
  const nodes = nestedNodes().map((entry) =>
    entry.label === 'Partially visible' ? { ...entry, enabled: false } : entry,
  );
  const unavailable = {
    ...acquisition(request, nodes),
    residue: [{ kind: 'unavailable-fact' as const, fact: 'hittability' as const }],
  } satisfies IosSnapshotAcquisition;
  const acquired = publishIosSnapshot({ stage: 'acquired', acquisition: unavailable }, request);
  const disabled = acquired.payload.nodes.find((node) => node.label === 'Partially visible');
  assert.ok(disabled);
  assert.equal(disabled.enabled, false);
  assert.equal(disabled.hittable, false);
});

test('interactive compaction stays available through the engine boundary', () => {
  const rowRect = { x: 16, y: 80, width: 288, height: 52 };
  const compacted = buildIosInteractiveSnapshotPresentation([
    node(0, 'Application', 'App', viewport),
    node(1, 'Table', 'Settings', { x: 0, y: 40, width: 320, height: 200 }, 0),
    node(2, 'Cell', 'General', rowRect, 1, 2),
    node(3, 'Button', 'General', rowRect, 2, 3),
    node(4, 'StaticText', 'General', rowRect, 3, 4),
  ]).nodes;

  assert.deepEqual(
    compacted.map((entry) => entry.type),
    ['Application', 'Table', 'Cell'],
  );
});

/**
 * `IosSnapshotEngine` has one operation because presentation happens once (#2188 invariant 2).
 * Pinning `publishIosSnapshot` to it keeps the contract a description of the export production
 * actually calls, rather than a shape only a factory ever satisfied (#2199).
 */
test('publishing satisfies the whole engine contract under an explicit fold policy', () => {
  const engine: IosSnapshotEngine = {
    publish: (input, request) =>
      publishIosSnapshot(input, request, { foldPolicy: 'plain-viewport' }),
  };
  const request = createIosSnapshotRequest();
  const presented = presentIosSnapshot(acquiredInput(request, nestedNodes()), request, {
    foldPolicy: 'plain-viewport',
  });

  assert.deepEqual(Object.keys(engine), ['publish']);
  assert.equal(
    engine.publish(acquiredInput(request, nestedNodes()), request).payload.nodes.length,
    presented.nodes.length,
  );
  assert.equal(presented.stats.sourceNodeCount, nestedNodes().length);
});

function acquisition(
  request: IosSnapshotRequest,
  nodes: RawSnapshotNode[],
): IosSnapshotAcquisition {
  const hint = deriveIosCaptureHint(request);
  assert.equal(hint.acquisitionIntent, 'full');
  return {
    producer: 'simulator-ax-bridge',
    intent: 'full',
    hint: { ...hint, acquisitionIntent: 'full' },
    nodes,
    truncated: false,
    viewport: { kind: 'reported', rect: viewport },
    lineage: { targetId: 'simulator-1', generation: 'generation-1' },
    residue: [{ kind: 'truncated' }],
  };
}

test("the published presented-surface fact is the acquisition's, for every projection", () => {
  const requests = [
    createIosSnapshotRequest(),
    createIosSnapshotRequest({ interactiveOnly: true }),
    createIosSnapshotRequest({ raw: true, depth: 1 }),
    createIosSnapshotRequest({ scope: 'Automation lab' }),
  ];
  const published = requests.map((request) =>
    publishIosSnapshot(acquiredInput(request, presentedTreeNodes()), request),
  );

  // One screen answers one value: the fact is read on the acquired tree, so a projection that dropped
  // the presentation from what it shows still reports the presentation the producer saw.
  assert.deepEqual(
    published.map((result) => result.presentedSurface),
    ['presented', 'presented', 'presented', 'presented'],
  );

  // The depth-1 cut here projects a full acquisition: the presentation sits at depth 2 and 3, so what
  // that capture publishes holds no trace of it. (A live `--raw --depth 1` bounds the acquisition
  // instead and answers `unknown`.) Were the fact read off the published nodes, this projection would
  // have to answer `absent` — which is the failure mode the fact exists to close.
  const depthCut = published[2]!;
  const publishedRoles = (depthCut.payload.nodes ?? []).map((node) => node.role);
  assert.ok(
    !publishedRoles.includes('UIDimmingView') && !publishedRoles.includes('UITransitionView'),
    `expected the depth-1 cut to drop the presentation, saw ${JSON.stringify(publishedRoles)}`,
  );
  assert.equal(depthCut.presentedSurface, 'presented');
});

test('an acquisition that states no completeness cannot be read as un-presented', () => {
  const request = createIosSnapshotRequest();
  const unstated: IosSnapshotAcquisition = {
    ...acquisition(request, ordinaryTreeNodes()),
    truncated: undefined,
  };

  assert.equal(
    publishIosSnapshot({ stage: 'acquired', acquisition: unstated }, request).presentedSurface,
    'unknown',
  );
  assert.equal(
    publishIosSnapshot(acquiredInput(request, ordinaryTreeNodes()), request).presentedSurface,
    'absent',
  );
});

test('a runner-declared publication states no presented-surface fact of its own', () => {
  const request = createIosSnapshotRequest();
  const input: IosSnapshotInput = {
    stage: 'presented',
    presentation: {
      producer: 'apple-runner',
      intent: 'full',
      payload: { nodes: presentedTreeNodes(), truncated: false },
    },
    validation: validationFacts(request),
  };

  // The runner classifies its own pre-presentation acquisition and publishes the reading beside the
  // payload; re-deriving one from the presented tree here would be a second, weaker answer. The same tree
  // answers at the acquired stage, so this pins the stage gate and not a classifier that reads neither:
  // a publication path that stopped classifying at all would fail the second assertion, not this one.
  assert.equal(publishIosSnapshot(input, request).presentedSurface, undefined);
  assert.equal(
    publishIosSnapshot(acquiredInput(request, presentedTreeNodes()), request).presentedSurface,
    'presented',
  );
});

function acquiredInput(request: IosSnapshotRequest, nodes: RawSnapshotNode[]): IosSnapshotInput {
  return { stage: 'acquired', acquisition: acquisition(request, nodes) };
}

function validationFacts(request: IosSnapshotRequest): IosSnapshotValidationFacts {
  return {
    presentationKey: buildIosSnapshotPresentationKey(request),
    viewport: { kind: 'reported', rect: viewport },
    hittability: { kind: 'available' },
    lineage: { targetId: 'simulator-1', generation: 'generation-1' },
    residue: [{ kind: 'truncated' }],
  };
}

function nestedNodes(): RawSnapshotNode[] {
  return [
    node(0, 'Application', 'App', viewport),
    node(1, 'ScrollView', 'Outer', { x: 16, y: 20, width: 180, height: 180 }, 0, 1),
    node(2, 'ScrollView', 'Inner', { x: 120, y: 40, width: 180, height: 160 }, 1, 2),
    node(3, 'Button', 'Partially visible', { x: 150, y: 80, width: 100, height: 40 }, 2, 3),
    node(4, 'Button', 'Escaped child', { x: 210, y: 80, width: 100, height: 40 }, 2, 3),
  ];
}

/** A UIKit-shaped tree over which a presentation is up: a second container carrying a dimming view. */
function presentedTreeNodes(): RawSnapshotNode[] {
  return [
    appNode(0, 'UIApplication', 'Application', viewport, undefined),
    appNode(1, 'UIWindow', 'Window', viewport, 0),
    appNode(2, 'UITransitionView', 'Other', viewport, 1, 2),
    node(3, 'StaticText', 'Automation lab', { x: 10, y: 20, width: 200, height: 20 }, 2, 3),
    appNode(4, 'UITransitionView', 'Other', viewport, 1, 2),
    {
      ...appNode(5, 'UIDimmingView', 'Other', viewport, 4, 3),
      userInteractionEnabled: true,
    },
    node(6, 'StaticText', 'Automation sheet', { x: 10, y: 120, width: 200, height: 20 }, 4, 3),
  ];
}

/** A UIKit-shaped tree with nothing presenting: one window, its own single container. */
function ordinaryTreeNodes(): RawSnapshotNode[] {
  return [
    appNode(0, 'UIApplication', 'Application', viewport, undefined),
    appNode(1, 'UIWindow', 'Window', viewport, 0),
    appNode(2, 'UITransitionView', 'Other', viewport, 1),
    appNode(
      3,
      'RCTParagraphComponentView',
      'StaticText',
      { x: 10, y: 20, width: 200, height: 20 },
      2,
    ),
  ];
}

/** A node shaped like the simulator AX bridge reports one: UIKit class name in `role`. */
function appNode(
  index: number,
  role: string,
  type: string,
  rect: Rect,
  parentIndex: number | undefined,
  depth?: number,
): RawSnapshotNode {
  return {
    ...node(index, type, undefined, rect, parentIndex, depth),
    role,
  };
}

function scopedNodes(): RawSnapshotNode[] {
  return [
    node(0, 'Application', 'App', viewport),
    node(1, 'Other', 'Wrapper', { x: 10, y: 10, width: 200, height: 100 }, 0, 1),
    node(2, 'Other', 'Target', { x: 10, y: 10, width: 200, height: 100 }, 1, 2),
    node(3, 'Button', 'Target', { x: 20, y: 20, width: 80, height: 40 }, 2, 3),
  ];
}

function node(
  index: number,
  type: string,
  label: string | undefined,
  rect: Rect,
  parentIndex?: number,
  depth?: number,
): RawSnapshotNode {
  return {
    index,
    type,
    label,
    rect,
    parentIndex,
    depth: depth ?? (parentIndex === undefined ? 0 : 1),
    enabled: true,
    hittable: type === 'Button',
  };
}
