import assert from 'node:assert/strict';
import fs from 'node:fs';
import { test } from 'vitest';
import type { RawSnapshotNode, Rect, SnapshotQualityNote } from '@agent-device/kernel/snapshot';
import {
  publicSnapshotCaptureAnnotations,
  readSerializedSnapshotCaptureAnnotations,
  snapshotCaptureAnnotationsFrom,
} from '@agent-device/contracts/capture';
import { createIosSnapshotAcquisition } from '../../ios-snapshot-acquisition.ts';
import { buildSnapshotState } from '../../snapshot-state.ts';
import { presentIosSnapshotAcquisition } from '../ios-snapshot-runtime.ts';

const fixture = JSON.parse(
  fs.readFileSync(
    new URL(
      '../../../../../contracts/fixtures/snapshot-presentation-conformance.json',
      import.meta.url,
    ),
    'utf8',
  ),
) as {
  viewport: Rect;
  cases: Array<{
    name: string;
    projection: 'raw' | 'regular';
    scope: string | null;
    nodes: Array<Omit<RawSnapshotNode, 'parentIndex'> & { parentIndex: number | null }>;
    expectedQualityNotes: SnapshotQualityNote[];
  }>;
};

test('host iOS presentation publishes shared clipping notes without inventing a capture verdict', () => {
  for (const producer of ['simulator-ax-bridge', 'appium-source', 'limrun-ios-tree'] as const) {
    for (const row of fixture.cases) {
      const acquired = createIosSnapshotAcquisition({
        producer: producer === 'simulator-ax-bridge' ? 'appium-source' : producer,
        nodes: row.nodes.map(({ parentIndex, ...node }) => ({
          ...node,
          ...(parentIndex === null ? {} : { parentIndex }),
        })),
        viewport: { kind: 'reported', rect: fixture.viewport },
        lineage: { targetId: 'test-app' },
      });
      const input = {
        ...acquired,
        acquisition: {
          ...acquired.acquisition,
          producer,
          residue: producer === 'simulator-ax-bridge' ? [] : acquired.acquisition.residue,
        },
      };
      const presented = presentIosSnapshotAcquisition(input, {
        raw: row.projection === 'raw',
        ...(row.scope ? { scope: row.scope } : {}),
      });
      assert.deepEqual(
        presented.qualityNotes ?? [],
        row.expectedQualityNotes,
        `${producer}: ${row.name}`,
      );
      assert.equal(presented.quality, undefined);
      const published = publicSnapshotCaptureAnnotations(snapshotCaptureAnnotationsFrom(presented));
      assert.deepEqual(published.snapshotQualityNotes ?? [], row.expectedQualityNotes, row.name);
      assert.equal(published.snapshotQuality, undefined);
      assert.deepEqual(readSerializedSnapshotCaptureAnnotations(published), published);
      const state = buildSnapshotState(presented, { snapshotRaw: row.projection === 'raw' });
      assert.deepEqual(state.snapshotQualityNotes ?? [], row.expectedQualityNotes, row.name);
    }
  }
});
