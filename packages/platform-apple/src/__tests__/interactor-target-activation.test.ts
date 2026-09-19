import assert from 'node:assert/strict';
import { test } from 'vitest';
import type { SnapshotResult } from '@agent-device/contracts/interactor-types';
import { IOS_SIMULATOR } from './device-fixtures.ts';
import type { AppleRunnerProvider } from '../runner/index.ts';
import { createAppleInteractor } from '../interactor.ts';

const HEALTHY_TREE = {
  nodes: [
    {
      index: 0,
      type: 'Application',
      label: 'Agent Device Tester',
      rect: { x: 0, y: 0, width: 402, height: 874 },
    },
    {
      index: 1,
      parentIndex: 0,
      type: 'Button',
      label: 'Home',
      rect: { x: 10, y: 800, width: 80, height: 40 },
      hittable: true,
    },
  ],
  truncated: false,
};

function interactorServing(payload: Record<string, unknown>) {
  const runnerProvider: AppleRunnerProvider = {
    hasLiveSession: () => true,
    runCommand: async () => payload,
  };
  return createAppleInteractor(IOS_SIMULATOR, { appBundleId: 'com.example.app' }, runnerProvider);
}

test('a capture whose own command repaired foreground discloses it and keeps the fact', async () => {
  const snapshot = (await interactorServing({
    ...HEALTHY_TREE,
    targetActivation: { reason: 'stale_target', priorState: 2, otherActiveApplicationPid: 4562 },
  }).snapshot()) as SnapshotResult;

  assert.deepEqual(snapshot.targetActivation, {
    reason: 'stale_target',
    priorState: 'runningBackground',
    otherActiveApplicationPid: 4562,
  });
  assert.match(
    String(snapshot.warnings?.find((warning) => warning.includes('not foreground'))),
    /prior state runningBackground[\s\S]*reason stale_target/,
  );
});

test('an untouched capture stays silent and carries no activation fact', async () => {
  const snapshot = (await interactorServing({
    ...HEALTHY_TREE,
    snapshotQuality: { state: 'healthy', backend: 'tree' },
  }).snapshot()) as SnapshotResult;

  assert.equal('targetActivation' in snapshot, false);
  assert.equal(snapshot.warnings, undefined);
});

test('an activation fact the runner could not attribute to one app discloses no pid', async () => {
  const snapshot = (await interactorServing({
    ...HEALTHY_TREE,
    targetActivation: { reason: 'interaction_foreground_guard', priorState: 2 },
  }).snapshot()) as SnapshotResult;

  assert.deepEqual(snapshot.targetActivation, {
    reason: 'interaction_foreground_guard',
    priorState: 'runningBackground',
  });
  assert.equal(snapshot.warnings?.[0]?.includes('pid'), false);
});
