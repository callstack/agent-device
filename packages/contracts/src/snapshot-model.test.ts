import { expect, test } from 'vitest';
import {
  readPostGestureOutcome,
  snapshotStateProvenance,
  type SnapshotProvenance,
  type SnapshotStateProvenance,
} from './snapshot-model.ts';

// The negative half of this test is type-level: each @ts-expect-error line fails `pnpm
// typecheck` the moment the provenance table would accept a cross-channel pair again.
test('the provenance table rejects cross-channel pairs at compile time', () => {
  const shared: SnapshotProvenance = { backend: 'xctest', producer: 'appium-source' };
  // @ts-expect-error the android channel cannot carry the apple-runner producer
  const crossChannel: SnapshotProvenance = { backend: 'android', producer: 'apple-runner' };
  // @ts-expect-error the web channel has exactly one producer
  const foreignProducer: SnapshotProvenance = { backend: 'web', producer: 'revyl-ios-tree' };
  // @ts-expect-error a state pair may omit the producer but not carry a foreign one
  const stateMismatch: SnapshotStateProvenance = {
    backend: 'macos-helper',
    producer: 'linux-atspi',
  };
  const stateWithoutProducer: SnapshotStateProvenance = { backend: 'android' };

  void [shared, crossChannel, foreignProducer, stateMismatch, stateWithoutProducer];
});

test('snapshotStateProvenance extracts exactly the pair', () => {
  expect(snapshotStateProvenance(undefined)).toEqual({});
  expect(snapshotStateProvenance({})).toEqual({});
  expect(snapshotStateProvenance({ backend: 'xctest', producer: 'revyl-ios-tree' })).toEqual({
    backend: 'xctest',
    producer: 'revyl-ios-tree',
  });
});

test('readPostGestureOutcome reads every outcome kind off the wire and drops malformed values', () => {
  const gesture = { action: 'open', positionals: [] };
  for (const kind of ['unsettled', 'no-effect', 'loading'] as const) {
    expect(readPostGestureOutcome({ kind, gesture })).toEqual({ kind, gesture });
  }
  expect(readPostGestureOutcome({ kind: 'toString', gesture })).toBeUndefined();
  expect(readPostGestureOutcome({ kind: 'loading', gesture: { action: 'open' } })).toBeUndefined();
  expect(
    readPostGestureOutcome({ kind: 'loading', gesture: { action: 'open', positionals: [1] } }),
  ).toBeUndefined();
  expect(readPostGestureOutcome('loading')).toBeUndefined();
});
