import type { CaptureSnapshotResult } from '@agent-device/contracts/client';

import type { SnapshotQualityVerdict } from '@agent-device/kernel/snapshot';

export type SnapshotBackendConformanceInput = Pick<
  CaptureSnapshotResult,
  'nodes' | 'snapshotQuality' | 'truncated'
>;

export function buildSnapshotBackendConformanceBase(): SnapshotBackendConformanceInput {
  return {
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
        hittable: true,
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
        hittable: true,
        rect: { x: 0, y: 20, width: 100, height: 20 },
      },
      { index: 2, ref: 'e3', type: 'ScrollView' },
    ],
  };
}
