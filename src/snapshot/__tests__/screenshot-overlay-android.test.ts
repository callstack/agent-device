import assert from 'node:assert/strict';
import { test } from 'vitest';
import type { SnapshotNode } from '@agent-device/kernel/snapshot';
import { makeSnapshotState } from '../../__tests__/test-utils/snapshot-builders.ts';
import {
  isAndroidUnlabeledClickableSource,
  resolveAndroidOverlaySourceRect,
} from '../screenshot-overlay/android.ts';

const SCREEN = { x: 0, y: 0, width: 1080, height: 1920 };

function androidSnapshot(nodes: Parameters<typeof makeSnapshotState>[0]) {
  return makeSnapshotState(nodes, { backend: 'android' });
}

const never = () => false;
const always = () => true;

// --- source classification ---

test('a hittable unlabeled Android node is an overlay source', () => {
  const snapshot = androidSnapshot([
    {
      index: 0,
      type: 'android.view.ViewGroup',
      hittable: true,
      rect: { x: 0, y: 0, width: 200, height: 120 },
    },
  ]);
  assert.equal(isAndroidUnlabeledClickableSource(snapshot, SCREEN, snapshot.nodes[0]!), true);
});

test('scroll containers, lists and text fields are regions rather than controls', () => {
  for (const type of [
    'android.widget.ScrollView',
    'androidx.recyclerview.widget.RecyclerView',
    'android.widget.EditText',
  ]) {
    const snapshot = androidSnapshot([
      { index: 0, type, hittable: true, rect: { x: 0, y: 0, width: 200, height: 120 } },
    ]);
    assert.equal(
      isAndroidUnlabeledClickableSource(snapshot, SCREEN, snapshot.nodes[0]!),
      false,
      type,
    );
  }
});

test('a node covering more than a quarter of the screen reads as layout', () => {
  const snapshot = androidSnapshot([
    {
      index: 0,
      type: 'android.view.ViewGroup',
      hittable: true,
      rect: { x: 0, y: 0, width: 1080, height: 960 },
    },
  ]);
  assert.equal(isAndroidUnlabeledClickableSource(snapshot, SCREEN, snapshot.nodes[0]!), false);
  // Without measured bounds there is nothing to call oversized against.
  assert.equal(isAndroidUnlabeledClickableSource(snapshot, null, snapshot.nodes[0]!), true);
});

test('the policy is inert on a non-Android backend', () => {
  const snapshot = makeSnapshotState(
    [{ index: 0, type: 'Button', hittable: true, rect: { x: 0, y: 0, width: 200, height: 120 } }],
    { backend: 'xctest' },
  );
  assert.equal(isAndroidUnlabeledClickableSource(snapshot, SCREEN, snapshot.nodes[0]!), false);
});

// --- source rect balancing ---

function actionRow(): SnapshotNode[] {
  return androidSnapshot([
    // A tall row whose visual content sits high inside it: 40px above, 120px below.
    {
      index: 0,
      type: 'android.view.ViewGroup',
      hittable: true,
      rect: { x: 0, y: 0, width: 400, height: 300 },
    },
    {
      index: 1,
      parentIndex: 0,
      type: 'android.widget.TextView',
      rect: { x: 20, y: 40, width: 200, height: 60 },
    },
    {
      index: 2,
      parentIndex: 0,
      type: 'android.widget.TextView',
      rect: { x: 20, y: 110, width: 200, height: 30 },
    },
  ]).nodes;
}

test('an action row with lopsided padding is balanced around its content', () => {
  const nodes = actionRow();
  const rect = resolveAndroidOverlaySourceRect(nodes[0]!, nodes, never, never);
  // Content spans y 40..140; the smaller padding (40 top) is mirrored below it.
  assert.deepEqual(rect, { x: 0, y: 0, width: 400, height: 180 });
});

test('a node that already carries a role or label keeps its own rect', () => {
  const nodes = actionRow();
  assert.equal(resolveAndroidOverlaySourceRect(nodes[0]!, nodes, always, never), null);
  assert.equal(resolveAndroidOverlaySourceRect(nodes[0]!, nodes, never, always), null);
});

test('a single content child is not enough to infer a row', () => {
  const nodes = androidSnapshot([
    {
      index: 0,
      type: 'android.view.ViewGroup',
      hittable: true,
      rect: { x: 0, y: 0, width: 400, height: 300 },
    },
    {
      index: 1,
      parentIndex: 0,
      type: 'android.widget.TextView',
      rect: { x: 20, y: 40, width: 200, height: 60 },
    },
  ]).nodes;
  assert.equal(resolveAndroidOverlaySourceRect(nodes[0]!, nodes, never, never), null);
});

test('a non-hittable or frameless target is never rebalanced', () => {
  const nodes = actionRow();
  const notHittable = { ...nodes[0]!, hittable: undefined };
  assert.equal(resolveAndroidOverlaySourceRect(notHittable, nodes, never, never), null);
  const frameless = { ...nodes[0]!, rect: undefined };
  assert.equal(resolveAndroidOverlaySourceRect(frameless, nodes, never, never), null);
});
