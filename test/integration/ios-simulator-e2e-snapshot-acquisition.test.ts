import assert from 'node:assert/strict';
import test from 'node:test';

import { assertSimulatorSnapshotAcquisition } from './ios-simulator-e2e/live-snapshot-depth-frontier.ts';

// #3328, pinned without a simulator: the depth-frontier scenario accepts either acquisition it
// can present depth facts from — the AX bridge (which publishes no verdict) or the XCTest runner
// the route sent the capture to (which always stamps its strategy) — and rejects only a capture
// whose own typed verdict says it degraded or served nothing. The positives are the exact shapes
// of the two failing main runs (37145696803, 37459193672), whose healthy `tree` verdict the old
// assertion failed on the word `tree`.

const HITTABLE = 'viewport-derived hittability evidence';

function capture(quality: unknown): { json?: any } {
  return {
    json: {
      success: true,
      data: {
        nodes: [{ index: 0, depth: 0, hittable: true }],
        ...(quality === undefined ? {} : { snapshotQuality: quality }),
        warnings: [HITTABLE],
      },
    },
  };
}

test('an AX-bridge capture carries no verdict and is accepted', () => {
  assertSimulatorSnapshotAcquisition(capture(undefined), 'regular depth-1 snapshot');
});

for (const backend of ['tree', 'queries', 'private-ax'] as const) {
  test(`a runner-served capture disclosing the ${backend} strategy is accepted`, () => {
    assertSimulatorSnapshotAcquisition(
      capture({ state: 'healthy', backend, timing: { acquisitionMs: 64.7, presentationMs: 0.09 } }),
      'regular depth-1 snapshot',
    );
  });
}

for (const reasonCode of ['deferred', 'requested-backend'] as const) {
  test(`a pre-selected-backend recovered verdict (${reasonCode}) is accepted`, () => {
    assertSimulatorSnapshotAcquisition(
      capture({ state: 'recovered', backend: 'private-ax', reasonCode }),
      'full raw visible-depth snapshot',
    );
  });
}

test('a capture that recovered to another strategy mid-capture is rejected', () => {
  // The closest negative to the pre-selected pair: the same `recovered` state with a degradation
  // code means the strategy the presented depth belongs to failed mid-capture, so the tree the
  // frontier assertions would read is not a comparable view of the screen (#1569).
  for (const reasonCode of ['capture-failed', 'presentation-failed', undefined]) {
    assert.throws(
      () =>
        assertSimulatorSnapshotAcquisition(
          capture({ state: 'recovered', backend: 'tree', ...(reasonCode ? { reasonCode } : {}) }),
          'regular depth-1 snapshot',
        ),
      /fell back to another capture strategy mid-capture/,
    );
  }
});

test('a sparse capture is rejected whatever strategy it names', () => {
  assert.throws(
    () =>
      assertSimulatorSnapshotAcquisition(
        capture({ state: 'sparse', backend: 'tree', reasonCode: 'sparse-tree' }),
        'regular depth-1 snapshot',
      ),
    /no backend served this screen/,
  );
});

test('a capture that declares its hittability evidence missing is rejected', () => {
  assert.throws(
    () =>
      assertSimulatorSnapshotAcquisition(
        {
          json: {
            success: true,
            data: {
              nodes: [{ index: 0, depth: 0 }],
              warnings: [
                'iOS snapshot acquisition does not provide hittability evidence; regular snapshots omit unverified hittability while raw snapshots preserve supplied facts.',
              ],
            },
          },
        },
        'regular depth-1 snapshot',
      ),
    /must derive hittability/,
  );
});
