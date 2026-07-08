import assert from 'node:assert/strict';
import { test } from 'vitest';
import { attachRefs, type RawSnapshotNode, type SnapshotState } from '../../kernel/snapshot.ts';
import {
  findAndroidGboardHandwritingTutorialCancel,
  hasAndroidGboardHandwritingTutorial,
} from '../android-input-method-overlays.ts';

test('detects localized Gboard handwriting tutorial by close button id', () => {
  const snapshot = snapshotState([
    gboardNode(0, {
      label: 'Prueba tu stylus',
      value: 'Prueba tu stylus',
    }),
    gboardNode(1, {
      identifier: 'android:id/closeButton',
      label: 'Cancelar',
      value: 'Cancelar',
    }),
  ]);

  assert.equal(hasAndroidGboardHandwritingTutorial(snapshot), true);
  assert.equal(findAndroidGboardHandwritingTutorialCancel(snapshot)?.index, 1);
});

test('ignores non-Gboard close buttons', () => {
  const snapshot = snapshotState([
    {
      index: 0,
      type: 'Button',
      bundleId: 'com.example.app',
      identifier: 'android:id/closeButton',
      label: 'Cancel',
    },
  ]);

  assert.equal(hasAndroidGboardHandwritingTutorial(snapshot), false);
  assert.equal(findAndroidGboardHandwritingTutorialCancel(snapshot), undefined);
});

function snapshotState(nodes: RawSnapshotNode[]): SnapshotState {
  return {
    nodes: attachRefs(nodes),
    createdAt: Date.now(),
    backend: 'android',
    presentationKey: 'test',
  };
}

function gboardNode(index: number, node: Partial<RawSnapshotNode>): RawSnapshotNode {
  return {
    index,
    type: 'TextView',
    bundleId: 'com.google.android.inputmethod.latin',
    ...node,
  };
}
