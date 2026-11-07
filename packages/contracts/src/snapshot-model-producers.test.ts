import assert from 'node:assert/strict';
import { test } from 'vitest';
import type { IosSnapshotProducer } from '@agent-device/contracts/ios-snapshot';
import { SNAPSHOT_PRODUCERS } from '@agent-device/contracts/snapshot-model';

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
  } as const satisfies Record<IosSnapshotProducer, 'available' | 'unavailable'>;

  for (const producer of Object.keys(expected) as IosSnapshotProducer[]) {
    assert.equal(SNAPSHOT_PRODUCERS[producer].truncation, expected[producer], producer);
  }
});
