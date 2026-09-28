import assert from 'node:assert/strict';
import { test } from 'vitest';
import { formatSnapshotLine } from '../snapshot-lines.ts';
import { attachRefs, type RawSnapshotNode } from '@agent-device/kernel/snapshot';

/**
 * #2656: `kind` on a structured snapshot node must be the exact role the text presenter prints for
 * that node, on every platform vocabulary, computed by the one function (`formatRole`) both paths
 * call. This feeds one iOS and one Android fixture tree through the production `attachRefs`
 * construction path and the production text line formatter, then asserts the two never disagree.
 */

const IOS_FIXTURE: RawSnapshotNode[] = [
  { index: 0, type: 'XCUIElementTypeApplication', label: 'Checkout' },
  { index: 1, type: 'XCUIElementTypeButton', label: 'Continue', parentIndex: 0 },
  { index: 2, type: 'XCUIElementTypeStaticText', label: 'Order total', parentIndex: 0 },
  { index: 3, type: 'XCUIElementTypeTextField', label: 'Promo code', parentIndex: 0 },
];

const ANDROID_FIXTURE: RawSnapshotNode[] = [
  { index: 0, type: 'android.widget.FrameLayout', parentIndex: undefined },
  { index: 1, type: 'android.widget.Button', label: 'Send code', parentIndex: 0 },
  { index: 2, type: 'android.widget.TextView', label: 'Order total', parentIndex: 0 },
  { index: 3, type: 'android.widget.EditText', label: 'Promo code', parentIndex: 0 },
];

function assertKindMatchesPresentedRole(fixture: RawSnapshotNode[], expected: string[]): void {
  const attached = attachRefs(fixture);
  assert.deepEqual(
    attached.map((node) => node.kind),
    expected,
  );
  for (const node of attached) {
    const line = formatSnapshotLine(node, 0, false);
    const presentedRole = /^@?\S*\s*\[([^\]]+)\]/.exec(line)?.[1];
    assert.equal(node.kind, presentedRole, `kind mismatch for ${node.type}: line was "${line}"`);
  }
}

test('kind equals the presenter role for every node of an iOS fixture tree', () => {
  assertKindMatchesPresentedRole(IOS_FIXTURE, ['application', 'button', 'text', 'text-field']);
});

test('kind equals the presenter role for every node of an Android fixture tree', () => {
  assertKindMatchesPresentedRole(ANDROID_FIXTURE, ['group', 'button', 'text', 'text-field']);
});
