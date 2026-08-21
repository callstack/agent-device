import { describe, expect, test } from 'vitest';

import {
  SNAPSHOT_BACKEND_CAPABILITIES,
  validateSnapshotBackendCapabilities,
} from './snapshot-backend-capabilities.ts';

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

  test('requires owned, tracked, future-dated gap metadata', () => {
    expect(validateSnapshotBackendCapabilities(undefined, '2026-08-21')).toEqual([]);

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
});
