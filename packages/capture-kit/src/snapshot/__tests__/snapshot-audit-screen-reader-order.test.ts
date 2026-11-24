import { expect, test } from 'vitest';
import type { AuditContext } from '@agent-device/contracts/capture';
import { attachSnapshotScreenReaderOrderEvidence } from '@agent-device/contracts/snapshot-private-evidence';
import type { SnapshotState } from '@agent-device/contracts/snapshot-model';
import type { SnapshotNode } from '@agent-device/kernel/snapshot';
import { auditSnapshotState } from '../snapshot-audit.ts';

const ANDROID: AuditContext = { platform: 'android', pixelDensity: 2, truncated: false };

function text(index: number, ref: string | undefined): SnapshotNode {
  return {
    index,
    ...(ref ? { ref } : {}),
    type: 'android.widget.TextView',
    label: `Row ${index}`,
    rect: { x: 0, y: index * 100, width: 400, height: 100 },
  };
}

function state(nodes: SnapshotNode[]): SnapshotState {
  return { nodes, createdAt: 0 };
}

test('reports the producer estimate as refs per window, with its limitation', async () => {
  const snapshot = state([text(0, 'e1'), text(1, 'e2'), text(2, 'e3')]);
  attachSnapshotScreenReaderOrderEvidence(snapshot, () => ({
    windows: [
      { nodeIndexes: [2], omittedStops: 0 },
      { nodeIndexes: [1, 0], omittedStops: 0 },
    ],
  }));
  const result = await auditSnapshotState(snapshot, ANDROID);
  expect(result.screenReaderOrder).toEqual({
    estimatedFrom: 'talkback-16.2',
    windows: [{ refs: ['@e3'] }, { refs: ['@e2', '@e1'] }],
  });
  expect(result.limitations).toContainEqual(expect.stringContaining('estimated from TalkBack'));
});

test('counts a stop without a ref as omitted and drops a window with no stop', async () => {
  const snapshot = state([text(0, 'e1'), text(1, undefined)]);
  attachSnapshotScreenReaderOrderEvidence(snapshot, () => ({
    windows: [
      { nodeIndexes: [], omittedStops: 0 },
      { nodeIndexes: [0, 1], omittedStops: 2 },
    ],
  }));
  expect((await auditSnapshotState(snapshot, ANDROID)).screenReaderOrder?.windows).toEqual([
    { refs: ['@e1'], omittedStops: 3 },
  ]);
});

test('a snapshot without the estimate reports no order and no order limitation', async () => {
  const result = await auditSnapshotState(state([text(0, 'e1')]), ANDROID);
  expect(result.screenReaderOrder).toBeUndefined();
  expect(result.limitations).toEqual([]);
});
