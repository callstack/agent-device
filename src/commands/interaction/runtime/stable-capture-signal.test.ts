import assert from 'node:assert/strict';
import { test } from 'vitest';
import { makeSnapshotState } from '../../../__tests__/test-utils/index.ts';
import { stableCaptureSignal, stableCaptureSignalsEqual } from './stable-capture-signal.ts';

function snapshot(jitter: number, hiddenY: number) {
  return makeSnapshotState(
    [
      {
        index: 0,
        depth: 0,
        type: 'Application',
        label: 'Element',
        rect: { x: 0, y: 0, width: 402, height: 874 },
        hittable: false,
      },
      {
        index: 1,
        depth: 1,
        parentIndex: 0,
        type: 'ScrollView',
        rect: { x: 0, y: 96, width: 402, height: 700 },
        hittable: true,
      },
      {
        index: 2,
        depth: 2,
        parentIndex: 1,
        type: 'Button',
        label: 'Profile',
        rect: { x: 17 + jitter, y: 120, width: 44, height: 44 },
        hittable: true,
      },
      {
        index: 3,
        depth: 2,
        parentIndex: 1,
        type: 'Button',
        label: 'Theme',
        rect: { x: 16, y: hiddenY, width: 360, height: 44 },
        hittable: false,
      },
    ],
    {
      snapshotQuality: {
        state: 'recovered',
        backend: 'private-ax',
        reasonCode: 'deferred',
        reason: 'penalty',
      },
    },
  );
}

test('private-ax stability ignores offscreen churn and boundary-crossing one-pixel jitter', () => {
  assert.equal(
    stableCaptureSignalsEqual(
      stableCaptureSignal(snapshot(0, 900)),
      stableCaptureSignal(snapshot(1, 980)),
    ),
    true,
  );
});
