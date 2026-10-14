import { buildSnapshotState } from '../../snapshot-state.ts';
import assert from 'node:assert/strict';
import { test } from 'vitest';
import { createIosSnapshotAcquisition } from '@agent-device/capture-kit/ios-snapshot-acquisition';
import {
  acquireProviderKeyboard,
  resolveKeyboardTapOcclusion,
} from '@agent-device/contracts/tap-keyboard-occlusion';
import { presentIosSnapshotAcquisition } from '../ios-snapshot-runtime.ts';
import type { IosViewportEvidence } from '@agent-device/contracts/ios-snapshot';
import { AppError } from '@agent-device/kernel/errors';
import type { RawSnapshotNode } from '@agent-device/kernel/snapshot';

// #3182: the provider acquisitions — the simulator AX bridge, an Appium page source, a Limrun tree —
// already resolve the box their nodes are measured in, and this presenter is the one seam that turns
// an acquisition into a snapshot result. Publishing nothing here left the default local-iOS producer
// without a viewport while it held the evidence, which is the issue's first `Done when` line.

const SCREEN = { x: 0, y: 0, width: 390, height: 844 };

const NODES: readonly RawSnapshotNode[] = [
  { index: 0, type: 'Application', rect: SCREEN },
  { index: 1, parentIndex: 0, type: 'Button', label: 'Open', rect: { ...SCREEN, width: 80 } },
];

function acquire(viewport: IosViewportEvidence) {
  return createIosSnapshotAcquisition({
    producer: 'appium-source',
    nodes: NODES,
    viewport,
    lineage: { targetId: 'sim-1:com.example.app' },
  });
}

test('an acquisition publishes the viewport box the regular fold measured against (#3182)', () => {
  const presented = presentIosSnapshotAcquisition(acquire({ kind: 'reported', rect: SCREEN }));

  assert.deepEqual(presented.viewport, { width: 390, height: 844 });
});

// The regular fold refuses a capture with no viewport, so absence is only reachable on a raw
// projection — which is also the projection that validates no box at all.
test('a raw acquisition publishes no viewport, since nothing checked it (#3182)', () => {
  const presented = presentIosSnapshotAcquisition(acquire({ kind: 'reported', rect: SCREEN }), {
    raw: true,
  });

  assert.equal('viewport' in presented, false);
});

test('a raw acquisition carrying the failed-read box publishes no viewport (#3182)', () => {
  const presented = presentIosSnapshotAcquisition(
    acquire({
      kind: 'reported',
      rect: {
        x: -Number.MAX_VALUE / 2,
        y: -Number.MAX_VALUE / 2,
        width: Number.MAX_VALUE,
        height: Number.MAX_VALUE,
      },
    }),
    { raw: true },
  );

  assert.equal('viewport' in presented, false);
});

test('a regular acquisition with no viewport evidence still refuses rather than minting one', () => {
  assert.throws(
    () => presentIosSnapshotAcquisition(acquire({ kind: 'missing', reason: 'not-provided' })),
    (error: unknown) => error instanceof AppError && error.code === 'COMMAND_FAILED',
  );
});

// The issue's second Done-when line: an empty screen still reports the box. The box is a property of
// the surface the producer read, so a tree that names nothing on it still answers the question.
test('an empty iOS acquisition still publishes the viewport it read (#3182)', () => {
  const empty = createIosSnapshotAcquisition({
    producer: 'appium-source',
    nodes: [],
    viewport: { kind: 'reported', rect: SCREEN },
    lineage: { targetId: 'sim-1:com.example.app' },
  });

  const presented = presentIosSnapshotAcquisition(empty);

  assert.deepEqual(presented.nodes, []);
  assert.deepEqual(presented.viewport, { width: 390, height: 844 });
});

test('provider keyboard evidence survives projection even when the tree has no keyboard nodes', () => {
  const keyboard = {
    kind: 'derived' as const,
    derivation: 'docked-tree' as const,
    frame: { x: 0, y: 580, width: 390, height: 264 },
  };
  const acquired = createIosSnapshotAcquisition({
    producer: 'appium-source',
    nodes: NODES,
    viewport: { kind: 'reported', rect: SCREEN },
    lineage: {},
    keyboard,
  });
  for (const options of [{ depth: 0 }, { interactiveOnly: true }, { raw: true }]) {
    assert.deepEqual(presentIosSnapshotAcquisition(acquired, options).keyboard, keyboard);
  }
});

test('a scoped keyboard control retains its acquired ownership after reindexing', () => {
  const nodes: RawSnapshotNode[] = [
    ...NODES,
    { index: 2, parentIndex: 0, type: 'Keyboard', rect: { x: 0, y: 580, width: 390, height: 264 } },
    {
      index: 3,
      parentIndex: 2,
      type: 'Button',
      label: 'Done',
      rect: { x: 200, y: 600, width: 100, height: 40 },
    },
  ];
  const acquired = createIosSnapshotAcquisition({
    producer: 'appium-source',
    ...acquireProviderKeyboard({ nodes, viewport: SCREEN }),
    viewport: { kind: 'reported', rect: SCREEN },
    lineage: {},
  });
  for (const raw of [false, true]) {
    const result = presentIosSnapshotAcquisition(acquired, { scope: 'Done', raw });
    const node = result.nodes!.find((n) => n.label === 'Done')!;
    assert.equal(
      resolveKeyboardTapOcclusion({
        nodes: result.nodes!,
        viewport: SCREEN,
        keyboard: result.keyboard,
        node,
        point: { x: 250, y: 620 },
      }).kind,
      'clear',
    );
  }
});

test('depth filtering and state normalization never promote app content into keyboard ownership', () => {
  const nodes: RawSnapshotNode[] = [
    { index: 0, depth: 0, type: 'Application', rect: SCREEN },
    { index: 1, depth: 1, parentIndex: 0, type: 'Other', rect: SCREEN },
    {
      index: 2,
      depth: 2,
      parentIndex: 1,
      type: 'Button',
      label: 'Nested',
      rect: { x: 10, y: 10, width: 100, height: 40 },
    },
    {
      index: 3,
      depth: 1,
      parentIndex: 0,
      type: 'Keyboard',
      rect: { x: 0, y: 580, width: 390, height: 264 },
    },
    {
      index: 4,
      depth: 1,
      parentIndex: 0,
      type: 'Button',
      label: 'Form',
      rect: { x: 200, y: 600, width: 100, height: 40 },
    },
  ];
  const acquired = createIosSnapshotAcquisition({
    producer: 'appium-source',
    ...acquireProviderKeyboard({ nodes, viewport: SCREEN }),
    viewport: { kind: 'reported', rect: SCREEN },
    lineage: {},
  });
  const result = presentIosSnapshotAcquisition(acquired, { raw: true, depth: 1 });
  const state = buildSnapshotState(result, { snapshotRaw: true });
  const node = state.nodes.find((n) => n.label === 'Form')!;
  assert.equal(node.keyboardOwned, false);
  assert.equal(
    resolveKeyboardTapOcclusion({
      nodes: state.nodes,
      viewport: SCREEN,
      keyboard: state.keyboard,
      node,
      point: { x: 250, y: 620 },
    }).kind,
    'occluded',
  );
});

test('depth projection cannot promote a rejected split keyboard into a trusted band', () => {
  const viewport = SCREEN;
  const nodes: RawSnapshotNode[] = [
    { index: 0, depth: 0, type: 'Application', rect: viewport },
    {
      index: 1,
      depth: 1,
      parentIndex: 0,
      type: 'Button',
      label: 'Between clusters',
      rect: { x: 150, y: 650, width: 40, height: 20 },
    },
    {
      index: 2,
      depth: 1,
      parentIndex: 0,
      type: 'Keyboard',
      rect: { x: 0, y: 580, width: 390, height: 264 },
    },
    ...[0, 310].map((x, offset) => ({
      index: 3 + offset,
      depth: 2,
      parentIndex: 2,
      type: 'Key',
      rect: { x, y: 600, width: 80, height: 40 },
    })),
  ];
  for (const visibility of [undefined, true] as const) {
    const acquired = createIosSnapshotAcquisition({
      producer: 'appium-source',
      ...acquireProviderKeyboard({ nodes, viewport, visibility }),
      viewport: { kind: 'reported', rect: viewport },
      lineage: {},
    });
    const projected = presentIosSnapshotAcquisition(acquired, { raw: true, depth: 1 });
    const state = buildSnapshotState(projected, { snapshotRaw: true });
    const node = state.nodes.find((n) => n.label === 'Between clusters')!;
    assert.equal(
      resolveKeyboardTapOcclusion({
        nodes: state.nodes,
        viewport,
        keyboard: state.keyboard,
        node,
        point: { x: 170, y: 660 },
      }).kind,
      'undetermined',
    );
  }
});
