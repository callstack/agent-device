// #3021 at the replay seam: `role=` vocabulary is resolved by the same
// `resolveRecordedTarget` path `replay` dispatches recorded targets through, so
// the alias window and the kind vocabulary are proven where released scripts
// actually run — not only at the matcher unit. ADR 0012 is untouched: nothing
// here rewrites a recorded expression; a miss still reports `no-match`.
import assert from 'node:assert/strict';
import { test } from 'vitest';
import { attachRefs, type RawSnapshotNode, type SnapshotNode } from '@agent-device/kernel/snapshot';
import { resolveRecordedTarget, type ReplayRecordedTargetPolicy } from './replay.ts';

const POLICY: ReplayRecordedTargetPolicy = {
  platform: 'ios',
  requireRect: true,
  allowDisambiguation: false,
};

// The production construction path, so the tree carries published `kind` the
// way every captured session tree does.
const rawNodes: RawSnapshotNode[] = [
  {
    index: 0,
    type: 'XCUIElementTypeStaticText',
    label: 'Total',
    rect: { x: 0, y: 0, width: 120, height: 20 },
  },
  {
    index: 1,
    type: 'XCUIElementTypeButton',
    label: 'Continue',
    rect: { x: 0, y: 30, width: 120, height: 44 },
  },
];
const nodes: SnapshotNode[] = attachRefs(rawNodes);

test('recorded legacy role= scripts keep resolving through the replay seam', () => {
  // `role=statictext` is the spelling released .ad scripts carry; the window
  // keeps them replaying against the same node they recorded against.
  const legacy = resolveRecordedTarget('role="statictext" label="Total"', nodes, POLICY);
  assert.equal(legacy.kind, 'resolved');
  if (legacy.kind === 'resolved') assert.equal(legacy.winner.ref, 'e1');
});

test('coarse kind selectors resolve through the replay seam too', () => {
  // The forward direction on the SAME seam a repaired/healed script would use.
  const coarse = resolveRecordedTarget('role="text" label="Total"', nodes, POLICY);
  assert.equal(coarse.kind, 'resolved');
  if (coarse.kind === 'resolved') assert.equal(coarse.winner.ref, 'e1');
});

test('a sibling kind stays a real miss at the replay seam — no silent widening', () => {
  // Nearest-negative: the divergence machinery downstream keys on
  // `reason: 'no-match'`; widening the vocabulary to a dash-sibling kind would
  // resolve this to the wrong node instead of diverging honestly.
  const miss = resolveRecordedTarget('role="text-field"', nodes, POLICY);
  assert.equal(miss.kind, 'unresolved');
  if (miss.kind === 'unresolved') assert.equal(miss.reason, 'no-match');
});
