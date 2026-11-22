import assert from 'node:assert/strict';
import { test } from 'vitest';
import type {
  IosProviderAcquisitionProducer,
  KnownIosSnapshotProducer,
} from '@agent-device/contracts/ios-snapshot';
import {
  SNAPSHOT_PRODUCERS,
  snapshotProducerFacts,
  type SnapshotProvenance,
  type ThirdPartySnapshotProducer,
} from '@agent-device/contracts/snapshot-producers';

/**
 * The producers that build their own residue declare truncation nowhere else, and the row must keep
 * saying what it said before, or `snapshotTruncationForResult` would start upgrading an absent
 * `truncated` to `false` (or stop doing so) for a real capture (#2199).
 */
test('truncation evidence is declared for every iOS producer', () => {
  const expected = {
    'apple-runner': 'available',
    'simulator-ax-bridge': 'available',
    'appium-source': 'unavailable',
    'revyl-ios-tree': 'unavailable',
  } as const satisfies Record<KnownIosSnapshotProducer, 'available' | 'unavailable'>;

  for (const producer of Object.keys(expected) as KnownIosSnapshotProducer[]) {
    assert.equal(SNAPSHOT_PRODUCERS[producer].truncation, expected[producer], producer);
  }
});

test('a third-party iOS producer is accepted without inventing facts', () => {
  const producer = 'vphone-ios-tree' as ThirdPartySnapshotProducer;
  const acquisitionProducer: IosProviderAcquisitionProducer = producer;
  const provenance: SnapshotProvenance = { backend: 'xctest', producer: acquisitionProducer };
  // @ts-expect-error source-measured producers do not use provider acquisition
  const sourceMeasuredProducer: IosProviderAcquisitionProducer = 'simulator-ax-bridge';
  void sourceMeasuredProducer;

  assert.deepEqual(provenance, { backend: 'xctest', producer: 'vphone-ios-tree' });
  assert.equal(snapshotProducerFacts(producer), undefined);
  assert.equal(SNAPSHOT_PRODUCERS['appium-source'].residue, 'provider-derived');
});
