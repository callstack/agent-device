import fs from 'node:fs';
import path from 'node:path';

import { describe, expect, test } from 'vitest';

import {
  SNAPSHOT_BACKEND_CAPABILITIES,
  validateSnapshotBackendCapabilities,
} from './snapshot-backend-capabilities.ts';

type SnapshotBackendParityFixture = {
  backends: Array<{
    name: string;
    forceable: boolean;
    supportsRawProjection: boolean;
    hittable: string;
    deepExtension: string;
    depthLadder: string;
    fixtureConformance: string;
    availability: { simulator: boolean; physicalDevice: boolean };
  }>;
};

const SNAPSHOT_BACKEND_PARITY_FIXTURE_PATH = path.resolve(
  import.meta.dirname,
  '..',
  '..',
  '..',
  'contracts',
  'fixtures',
  'ios-snapshot-backends.json',
);

function readSnapshotBackendParityFixture(): SnapshotBackendParityFixture {
  return JSON.parse(
    fs.readFileSync(SNAPSHOT_BACKEND_PARITY_FIXTURE_PATH, 'utf8'),
  ) as SnapshotBackendParityFixture;
}

describe('iOS snapshot backend capability registry', () => {
  test('classifies every backend and derives independent conformance targets', () => {
    expect(Object.keys(SNAPSHOT_BACKEND_CAPABILITIES).sort()).toEqual([
      'private-ax',
      'queries',
      'tree',
    ]);
    expect(
      Object.entries(SNAPSHOT_BACKEND_CAPABILITIES)
        .filter(([, capability]) => capability.fixtureConformance === 'required')
        .map(([backend]) => backend),
    ).toEqual(['tree', 'private-ax']);

    expect(SNAPSHOT_BACKEND_CAPABILITIES.tree).toMatchObject({
      forceable: true,
      supportsRawProjection: true,
      hittable: 'hit-tested',
      deepExtension: 'no',
      depthLadder: 'n/a',
      fixtureConformance: 'required',
    });
    expect(SNAPSHOT_BACKEND_CAPABILITIES['private-ax']).toMatchObject({
      forceable: true,
      supportsRawProjection: true,
      hittable: 'approximated',
      deepExtension: 'yes',
      depthLadder: 'yes',
      fixtureConformance: 'required',
    });
    expect(SNAPSHOT_BACKEND_CAPABILITIES.queries).toMatchObject({
      forceable: false,
      supportsRawProjection: false,
      fixtureConformance: 'not-applicable',
    });
  });

  test('keeps the Swift backend declaration on the cross-runtime parity table', () => {
    const fixture = readSnapshotBackendParityFixture();
    expect(fixture.backends.map((backend) => backend.name)).toEqual(
      Object.keys(SNAPSHOT_BACKEND_CAPABILITIES),
    );
    for (const backend of fixture.backends) {
      const capability =
        SNAPSHOT_BACKEND_CAPABILITIES[backend.name as keyof typeof SNAPSHOT_BACKEND_CAPABILITIES];
      expect(capability).toMatchObject({
        forceable: backend.forceable,
        supportsRawProjection: backend.supportsRawProjection,
        hittable: backend.hittable,
        deepExtension: backend.deepExtension,
        depthLadder: backend.depthLadder,
        fixtureConformance: backend.fixtureConformance,
      });
    }
  });

  test('requires owned, tracked, future-dated gap metadata', () => {
    expect(validateSnapshotBackendCapabilities(undefined, '2026-08-21')).toEqual([]);
    expect(validateSnapshotBackendCapabilities()).toEqual([]);

    const invalidRegistry = {
      ...SNAPSHOT_BACKEND_CAPABILITIES,
      tree: {
        ...SNAPSHOT_BACKEND_CAPABILITIES.tree,
        knownGaps: [
          {
            ...SNAPSHOT_BACKEND_CAPABILITIES.tree.knownGaps[0],
            owner: '',
            trackingIssue: 0,
            expiresOn: '2026-08-20',
          },
        ],
      },
    };
    const errors = validateSnapshotBackendCapabilities(invalidRegistry, '2026-08-21');

    expect(errors).toEqual([
      'tree gap deep-extension must name an owner',
      'tree gap deep-extension must name a positive tracking issue',
      'tree gap deep-extension expiresOn must be after 2026-08-21',
    ]);
  });

  test('rejects a gap on its expiry date and accepts the preceding date', () => {
    const expiringRegistry = {
      ...SNAPSHOT_BACKEND_CAPABILITIES,
      tree: {
        ...SNAPSHOT_BACKEND_CAPABILITIES.tree,
        knownGaps: [
          {
            ...SNAPSHOT_BACKEND_CAPABILITIES.tree.knownGaps[0],
            expiresOn: '2026-08-21',
          },
        ],
      },
    };

    expect(validateSnapshotBackendCapabilities(expiringRegistry, '2026-08-20')).toEqual([]);
    expect(validateSnapshotBackendCapabilities(expiringRegistry, '2026-08-21')).toEqual([
      'tree gap deep-extension expiresOn must be after 2026-08-21',
    ]);
  });
});
