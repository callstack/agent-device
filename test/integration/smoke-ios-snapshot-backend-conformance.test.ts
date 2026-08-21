import assert from 'node:assert/strict';
import test from 'node:test';

import type { SnapshotQualityVerdict } from '@agent-device/kernel/snapshot';
import {
  assertSnapshotBackendConformance,
  loadSnapshotBackendConformanceFixture,
} from './ios-simulator-e2e/snapshot-backend-conformance.ts';

const fixture = loadSnapshotBackendConformanceFixture();

test('snapshot backend conformance checks each backend contract independently', () => {
  const base = {
    truncated: false,
    snapshotQuality: { state: 'healthy', backend: 'tree' } satisfies SnapshotQualityVerdict,
    nodes: [
      {
        index: 0,
        ref: 'e1',
        identifier: 'field-name',
        label: 'Full name',
        type: 'TextField',
        value: 'Ada Lovelace',
        enabled: true,
        hittable: false,
        rect: { x: 0, y: 0, width: 100, height: 20 },
      },
      {
        index: 1,
        ref: 'e2',
        identifier: 'field-email',
        label: 'Email',
        type: 'TextField',
        value: 'ada@example.test',
        enabled: true,
        hittable: false,
        rect: { x: 0, y: 20, width: 100, height: 20 },
      },
      { index: 2, ref: 'e3', type: 'ScrollView' },
    ],
  };

  assert.doesNotThrow(() => assertSnapshotBackendConformance(base, 'tree', fixture));
  assert.throws(
    () =>
      assertSnapshotBackendConformance(
        { ...base, snapshotQuality: { state: 'healthy', backend: 'tree' } },
        'private-ax',
        fixture,
      ),
    /private-ax capture must prove its backend/,
  );
});
