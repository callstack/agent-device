import { expect, test } from 'vitest';
import {
  androidSnapshotSystemSurface,
  readPostGestureOutcome,
  snapshotStateProvenance,
  systemSurfaceBundleId,
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

test('systemSurfaceBundleId projects the host identity only for host-bearing surfaces', () => {
  expect(systemSurfaceBundleId(undefined)).toBeUndefined();
  expect(systemSurfaceBundleId({ kind: 'android-system-overlay' })).toBeUndefined();
  expect(systemSurfaceBundleId({ kind: 'web-auth', bundleId: 'com.apple.SafariViewService' })).toBe(
    'com.apple.SafariViewService',
  );
  expect(systemSurfaceBundleId({ kind: 'payment', bundleId: 'com.apple.PassbookUIService' })).toBe(
    'com.apple.PassbookUIService',
  );
});

test('androidSnapshotSystemSurface maps systemSurfaceOnly to the shared Android overlay arm', () => {
  expect(androidSnapshotSystemSurface(undefined)).toBeUndefined();
  expect(androidSnapshotSystemSurface({})).toBeUndefined();
  expect(androidSnapshotSystemSurface({ systemSurfaceOnly: false })).toBeUndefined();
  expect(androidSnapshotSystemSurface({ systemSurfaceOnly: true })).toEqual({
    kind: 'android-system-overlay',
  });
});
