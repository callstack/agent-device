import assert from 'node:assert/strict';
import type { RawSnapshotNode, SnapshotNode } from '../../../kernel/snapshot.ts';
import { computeTargetEvidence } from '../../session-target-evidence.ts';
import type { TargetAnnotationV1 } from '../../../replay/target-identity.ts';

export function toSnapshotNodes(raw: RawSnapshotNode[]): SnapshotNode[] {
  return raw.map((node, position) => ({ ...node, ref: `e${position + 1}` }));
}

export function bottomTabsRealCaptureFixture(): SnapshotNode[] {
  return toSnapshotNodes([
    {
      index: 0,
      type: 'Application',
      label: 'React Navigation Example',
      rect: { x: 0, y: 0, width: 402, height: 874 },
      enabled: true,
      hittable: true,
      depth: 0,
    },
    {
      index: 1,
      type: 'Window',
      rect: { x: 0, y: 0, width: 402, height: 874 },
      enabled: true,
      hittable: true,
      depth: 1,
      parentIndex: 0,
    },
    {
      index: 2,
      type: 'ScrollView',
      label: 'Contacts',
      rect: { x: 0, y: 116, width: 402, height: 675 },
      enabled: true,
      hittable: false,
      hiddenContentBelow: true,
      depth: 2,
      parentIndex: 1,
    },
    {
      index: 3,
      type: 'StaticText',
      label: 'Marissa Castillo',
      rect: { x: 52, y: 132, width: 110, height: 17 },
      enabled: true,
      depth: 3,
      parentIndex: 2,
    },
    {
      index: 4,
      type: 'Other',
      rect: { x: 0, y: 791, width: 402, height: 83 },
      enabled: true,
      hittable: false,
      depth: 2,
      parentIndex: 1,
    },
    {
      index: 5,
      type: 'Button',
      label: 'Article, unselected',
      identifier: 'article',
      rect: { x: 0, y: 791, width: 101, height: 49 },
      enabled: true,
      hittable: false,
      depth: 3,
      parentIndex: 4,
    },
    {
      index: 6,
      type: 'Button',
      label: 'Chat, unselected',
      identifier: 'chat',
      rect: { x: 101, y: 791, width: 100, height: 49 },
      enabled: true,
      hittable: false,
      depth: 3,
      parentIndex: 4,
    },
  ]);
}

export function recordArticleEvidence(): TargetAnnotationV1 {
  const nodes = bottomTabsRealCaptureFixture();
  const winner = nodes.find((node) => node.label === 'Article, unselected');
  if (!winner) throw new Error('fixture missing Article tab');
  const evidence = computeTargetEvidence({ node: winner, preActionNodes: nodes });
  assert.ok(evidence);
  assert.equal(evidence.verification, 'verified');
  return evidence;
}
