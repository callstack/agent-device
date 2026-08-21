import fs from 'node:fs';
import path from 'node:path';

import { expect, test } from 'vitest';

import { SNAPSHOT_BACKEND_CAPABILITIES } from './backend-capabilities.ts';

type SnapshotBackendParityFixture = {
  backends: Array<{
    name: string;
    forceable: boolean;
    supportsRawProjection: boolean;
    hittable: string;
    deepExtension: string;
    depthLadder: string;
    availability: { simulator: boolean; physicalDevice: boolean };
    knownGaps: SnapshotBackendGap[];
  }>;
};

type SnapshotBackendGap = {
  id: string;
  owner: string;
  trackingIssue: number;
  expiresOn: string;
};

const SNAPSHOT_BACKEND_PARITY_FIXTURE_PATH = path.resolve(
  import.meta.dirname,
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

function validateSnapshotBackendGaps(
  backends: readonly { name: string; knownGaps: readonly SnapshotBackendGap[] }[],
  asOf = new Date().toISOString().slice(0, 10),
): string[] {
  const gapIds = new Set<string>();
  return backends.flatMap((backend) =>
    backend.knownGaps.flatMap((gap) => [
      ...validateGapId(backend.name, gap.id, gapIds),
      ...validateGapMetadata(backend.name, gap, asOf),
    ]),
  );
}

function validateGapId(backend: string, id: string, gapIds: Set<string>): string[] {
  if (id.trim().length === 0) return [`${backend} gap must have an id`];
  if (gapIds.has(id)) return [`duplicate snapshot backend gap id ${id}`];
  gapIds.add(id);
  return [];
}

function validateGapMetadata(backend: string, gap: SnapshotBackendGap, asOf: string): string[] {
  return [
    gap.owner.trim().length === 0 ? `${backend} gap ${gap.id} must name an owner` : undefined,
    !Number.isInteger(gap.trackingIssue) || gap.trackingIssue <= 0
      ? `${backend} gap ${gap.id} must name a positive tracking issue`
      : undefined,
    !/^\d{4}-\d{2}-\d{2}$/.test(gap.expiresOn) || gap.expiresOn <= asOf
      ? `${backend} gap ${gap.id} expiresOn must be after ${asOf}`
      : undefined,
  ].filter((error): error is string => error !== undefined);
}

test('iOS snapshot registry classifies every backend and conformance target', () => {
  expect(Object.keys(SNAPSHOT_BACKEND_CAPABILITIES).sort()).toEqual([
    'private-ax',
    'queries',
    'tree',
  ]);
  expect(
    Object.entries(SNAPSHOT_BACKEND_CAPABILITIES)
      .filter(([, capability]) => capability.forceable)
      .map(([backend]) => backend),
  ).toEqual(['tree', 'private-ax']);

  expect(SNAPSHOT_BACKEND_CAPABILITIES.tree).toMatchObject({
    forceable: true,
    supportsRawProjection: true,
    hittable: 'geometric-actionability',
    deepExtension: 'no',
    depthLadder: 'n/a',
  });
  expect(SNAPSHOT_BACKEND_CAPABILITIES['private-ax']).toMatchObject({
    forceable: true,
    supportsRawProjection: true,
    hittable: 'geometric-actionability',
    deepExtension: 'yes',
    depthLadder: 'yes',
  });
  expect(SNAPSHOT_BACKEND_CAPABILITIES.queries).toMatchObject({
    forceable: false,
    supportsRawProjection: false,
    hittable: 'geometric-actionability',
  });
});

test('Swift and TypeScript snapshot backend declarations match the parity table', () => {
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
    });
    expect(capability.knownGaps).toEqual(backend.knownGaps.map((gap) => gap.id));
  }
});

test('snapshot backend gaps require unique, owned, tracked, future-dated metadata', () => {
  const fixture = readSnapshotBackendParityFixture();
  expect(validateSnapshotBackendGaps(fixture.backends, '2026-08-21')).toEqual([]);
  expect(validateSnapshotBackendGaps(fixture.backends)).toEqual([]);

  const tree = fixture.backends.find((backend) => backend.name === 'tree');
  const deepExtensionGap = tree?.knownGaps.find((gap) => gap.id === 'deep-extension');
  if (!tree || !deepExtensionGap) throw new Error('tree deep-extension fixture gap is missing');
  const invalidBackends = fixture.backends.map((backend) =>
    backend === tree
      ? {
          ...backend,
          knownGaps: [
            {
              ...deepExtensionGap,
              owner: '',
              trackingIssue: 0,
              expiresOn: '2026-08-20',
            },
          ],
        }
      : backend,
  );

  expect(validateSnapshotBackendGaps(invalidBackends, '2026-08-21')).toEqual([
    'tree gap deep-extension must name an owner',
    'tree gap deep-extension must name a positive tracking issue',
    'tree gap deep-extension expiresOn must be after 2026-08-21',
  ]);
});

test('snapshot backend gaps expire on their boundary date', () => {
  const fixture = readSnapshotBackendParityFixture();
  const expiringBackends = fixture.backends.map((backend) =>
    backend.name === 'tree'
      ? {
          ...backend,
          knownGaps: backend.knownGaps.map((gap) => ({
            ...gap,
            expiresOn: '2026-08-21',
          })),
        }
      : backend,
  );

  expect(validateSnapshotBackendGaps(expiringBackends, '2026-08-20')).toEqual([]);
  expect(validateSnapshotBackendGaps(expiringBackends, '2026-08-21')).toEqual([
    'tree gap deep-extension expiresOn must be after 2026-08-21',
  ]);
});
