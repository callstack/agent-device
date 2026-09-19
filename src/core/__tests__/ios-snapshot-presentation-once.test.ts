import { expect, test } from 'vitest';
import { presentIosInteractiveSnapshot } from '@agent-device/capture-kit/ios-snapshot-engine';
import type {
  IosAcquisitionProducer,
  IosSnapshotProducer,
} from '@agent-device/contracts/ios-snapshot';
import type { SnapshotRuntimeAcquiredResult } from '@agent-device/contracts/interactor-types';
import type { RawSnapshotNode, Rect } from '@agent-device/kernel/snapshot';
import { presentIosSnapshotAcquisition } from '@agent-device/capture-kit/ios-snapshot-runtime';
import { buildSnapshotState } from '@agent-device/capture-kit/snapshot-state';

/**
 * #2188 invariant 2: geometric presentation happens exactly ONCE per capture. Before #2199 the
 * daemon assembly ran the iOS semantic presentation a second time for any producer whose
 * capability table still claimed `presentationOwner: 'snapshot-state'`, so an engine-presented
 * bridge tree was compacted twice. These tests pin both halves — the engine presents, and the
 * assembly is the identity on an already-presented iOS tree — for every live producer.
 */

const VIEWPORT: Rect = { x: 0, y: 0, width: 320, height: 480 };
const ROW: Rect = { x: 16, y: 80, width: 288, height: 52 };

const ACQUISITION_PRODUCERS: readonly IosAcquisitionProducer[] = [
  'simulator-ax-bridge',
  'appium-source',
  'limrun-ios-tree',
];
const PRODUCERS: readonly IosSnapshotProducer[] = ['apple-runner', ...ACQUISITION_PRODUCERS];

/** A row whose Cell/Button/StaticText share one label: the shape iOS compaction folds. */
function collapsibleNodes(): RawSnapshotNode[] {
  return [
    node(0, 'Application', 'App', VIEWPORT),
    node(1, 'Table', 'Settings', { x: 0, y: 40, width: 320, height: 300 }, 0, 1),
    node(2, 'Cell', 'General', ROW, 1, 2),
    node(3, 'Button', 'General', ROW, 2, 3),
    node(4, 'StaticText', 'General', ROW, 3, 4),
  ];
}

function node(
  index: number,
  type: string,
  label: string,
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
    depth: depth ?? 0,
    enabled: true,
    hittable: type === 'Button',
  };
}

function acquired(
  producer: IosAcquisitionProducer,
  nodes: RawSnapshotNode[],
): SnapshotRuntimeAcquiredResult {
  return {
    stage: 'acquired',
    acquisition: {
      producer,
      intent: 'full',
      nodes,
      truncated: false,
      viewport: { kind: 'reported', rect: VIEWPORT },
      lineage: { targetId: 'ios-1:com.example.app', generation: 'launch-a' },
      residue:
        producer === 'simulator-ax-bridge'
          ? [{ kind: 'unavailable-fact', fact: 'acquisition-depth' }]
          : [
              { kind: 'unavailable-fact', fact: 'hittability' },
              { kind: 'unavailable-fact', fact: 'acquisition-depth' },
              { kind: 'unavailable-fact', fact: 'truncation' },
            ],
    },
  };
}

const shape = (nodes: readonly RawSnapshotNode[]) =>
  nodes.map((entry) => [entry.type, entry.label]);

// The positive control for every fixed-point assertion below: the acquired tree genuinely needs
// compaction, so "already compacted" cannot pass by the rules having stopped matching.
test('the collapsible fixture is not already a presentation fixed point', () => {
  const acquisitionNodes = collapsibleNodes();

  expect(presentIosInteractiveSnapshot(acquisitionNodes).length).toBeLessThan(
    acquisitionNodes.length,
  );
});

test.each(ACQUISITION_PRODUCERS)(
  'iOS presentation runs exactly once from acquisition to published state (%s)',
  (producer) => {
    const result = presentIosSnapshotAcquisition(acquired(producer, collapsibleNodes()), {
      interactiveOnly: true,
    });
    const published = result.nodes ?? [];

    // Presented at least once: the engine's output is a fixed point of the presentation rules.
    expect(shape(presentIosInteractiveSnapshot([...published]))).toEqual(shape(published));
    // Presented at most once: the daemon assembly passes the engine's tree through untouched.
    expect(shape(buildSnapshotState(result, { snapshotInteractiveOnly: true }).nodes)).toEqual(
      shape(published),
    );
  },
);

test.each(PRODUCERS)('the daemon assembly never presents an iOS tree (%s)', (producer) => {
  const nodes = collapsibleNodes();

  const state = buildSnapshotState(
    { nodes, backend: 'xctest', producer },
    { snapshotInteractiveOnly: true },
  );

  expect(shape(state.nodes)).toEqual(shape(nodes));
});

test.each(PRODUCERS)(
  'the daemon assembly never scopes an iOS tree a second time (%s)',
  (producer) => {
    const nodes = collapsibleNodes();

    // The engine owns iOS scope, so a scope the assembly cannot match must not reach the tree: a
    // second post-wire pass would return the empty no-match slice instead of the presented tree.
    const state = buildSnapshotState(
      { nodes, backend: 'xctest', producer },
      { snapshotInteractiveOnly: true, snapshotScope: 'no-such-scope' },
    );

    expect(shape(state.nodes)).toEqual(shape(nodes));
  },
);
