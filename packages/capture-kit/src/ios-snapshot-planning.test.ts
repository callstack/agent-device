import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'vitest';
import type {
  CaptureHint,
  IosSnapshotComparisonIdentity,
  IosSnapshotEvidenceAvailability,
  IosSnapshotInput,
  IosSnapshotProducer,
  IosSnapshotRequestInput,
} from '@agent-device/contracts/ios-snapshot';
import {
  areIosSnapshotComparisonIdentitiesEqual,
  buildIosSnapshotComparisonIdentity,
  buildIosSnapshotPresentationKey,
  createIosSnapshotRequest,
  deriveIosCaptureHint,
} from '@agent-device/capture-kit/ios-snapshot-planning';
import {
  createIosSnapshotAcquisition,
  iosSnapshotTruncationEvidence,
} from '@agent-device/capture-kit/ios-snapshot-acquisition';

type CaptureHintFixture = Readonly<{
  name: string;
  request: IosSnapshotRequestInput;
  expected: CaptureHint;
}>;

const TABLE_PATH = path.resolve(
  import.meta.dirname,
  '..',
  '..',
  '..',
  'contracts',
  'fixtures',
  'ios-snapshot-capture-hint.json',
);

test('the request-to-capture-hint table is exhaustive', () => {
  const fixtures = JSON.parse(fs.readFileSync(TABLE_PATH, 'utf8')) as CaptureHintFixture[];
  assert.ok(fixtures.length > 0, 'capture-hint table must not be empty');
  assert.equal(new Set(fixtures.map((fixture) => fixture.name)).size, fixtures.length);
  for (const fixture of fixtures) {
    const request = createIosSnapshotRequest(fixture.request);
    assert.deepEqual(deriveIosCaptureHint(request), fixture.expected, fixture.name);
  }
});

test('normalization makes raw, scope, and absent values explicit', () => {
  const request = createIosSnapshotRequest({
    raw: true,
    depth: 2,
    scope: '  Card  ',
    acquisitionIntent: 'surface-observation',
  });
  assert.deepEqual(request, {
    projection: 'raw',
    interactiveOnly: false,
    depth: 2,
    scope: 'Card',
    customActions: false,
    acquisitionIntent: 'surface-observation',
  });
  assert.deepEqual(buildIosSnapshotPresentationKey(request), {
    projection: 'raw',
    interactiveOnly: false,
    depth: 2,
    scope: 'Card',
    customActions: false,
  });
});

test('acquisition derives unavailable provider facts from the registry', () => {
  for (const producer of ['appium-source', 'limrun-ios-tree'] as const) {
    assert.deepEqual(
      createIosSnapshotAcquisition({
        producer,
        nodes: [],
        viewport: { kind: 'reported', rect: { x: 0, y: 0, width: 1, height: 1 } },
        lineage: {},
      }).acquisition.residue,
      [
        { kind: 'unavailable-fact', fact: 'hittability' },
        { kind: 'unavailable-fact', fact: 'acquisition-depth' },
        { kind: 'unavailable-fact', fact: 'truncation' },
      ],
      producer,
    );
  }
});

/**
 * The producers that build their own residue have no row in the provider capability table, so
 * this is the only place they declare a capability at all — and it must keep saying what it said
 * before the table was narrowed, or `snapshotTruncationForResult` would start upgrading an absent
 * `truncated` to `false` (or stop doing so) for a real capture (#2199).
 */
test('truncation evidence is declared for every iOS producer', () => {
  const expected = {
    'apple-runner': 'available',
    'simulator-ax-bridge': 'available',
    'appium-source': 'unavailable',
    'limrun-ios-tree': 'unavailable',
  } as const satisfies Record<IosSnapshotProducer, IosSnapshotEvidenceAvailability>;

  for (const producer of Object.keys(expected) as IosSnapshotProducer[]) {
    assert.equal(iosSnapshotTruncationEvidence(producer), expected[producer], producer);
  }
});

test('comparison identity rejects every identity axis and residue mismatch', () => {
  const base = comparisonIdentity();
  const mismatches: IosSnapshotComparisonIdentity[] = [
    { ...base, producer: 'limrun-ios-tree' },
    { ...base, intent: 'surface-observation' },
    { ...base, lineage: { targetId: 'simulator-1', generation: 'generation-2' } },
    { ...base, presentationKey: { ...base.presentationKey, depth: 1 } },
    { ...base, residue: [{ kind: 'truncated', dimension: 'nodes' }] },
  ];
  assert.equal(areIosSnapshotComparisonIdentitiesEqual(base, { ...base }), true);
  assert.equal(
    areIosSnapshotComparisonIdentitiesEqual(base, {
      ...base,
      residue: [{ kind: 'provider-pruned', fields: ['scope', 'nodes'] }],
    }),
    false,
  );
  for (const mismatch of mismatches) {
    assert.equal(areIosSnapshotComparisonIdentitiesEqual(base, mismatch), false);
  }
  assert.equal(
    areIosSnapshotComparisonIdentitiesEqual(
      { ...base, residue: [{ kind: 'provider-pruned', fields: ['scope', 'nodes'] }] },
      { ...base, residue: [{ kind: 'provider-pruned', fields: ['nodes', 'scope'] }] },
    ),
    true,
  );
});

test('comparison identity builder follows the closed input stage', () => {
  const request = createIosSnapshotRequest({ acquisitionIntent: 'surface-observation' });
  const acquired: IosSnapshotInput = {
    stage: 'acquired',
    acquisition: {
      producer: 'simulator-ax-bridge',
      intent: 'surface-observation',
      hint: {
        ...deriveIosCaptureHint(request),
        acquisitionIntent: 'surface-observation',
      },
      nodes: [],
      truncated: false,
      viewport: { kind: 'reported', rect: { x: 0, y: 0, width: 10, height: 10 } },
      lineage: { targetId: 'simulator-1', generation: 'generation-1' },
      residue: [],
    },
  };
  assert.deepEqual(buildIosSnapshotComparisonIdentity(acquired, request), {
    producer: 'simulator-ax-bridge',
    intent: 'surface-observation',
    lineage: { targetId: 'simulator-1', generation: 'generation-1' },
    presentationKey: {
      projection: 'regular',
      interactiveOnly: false,
      depth: null,
      scope: null,
      customActions: false,
    },
    residue: [],
  });
});

function comparisonIdentity(
  overrides: Partial<IosSnapshotComparisonIdentity> = {},
): IosSnapshotComparisonIdentity {
  return {
    producer: 'simulator-ax-bridge',
    intent: 'full',
    lineage: { targetId: 'simulator-1', generation: 'generation-1' },
    presentationKey: {
      projection: 'regular',
      interactiveOnly: false,
      depth: null,
      scope: null,
      customActions: false,
    },
    residue: [],
    ...overrides,
  };
}
