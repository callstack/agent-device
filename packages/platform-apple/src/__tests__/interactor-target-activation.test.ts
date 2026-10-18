import assert from 'node:assert/strict';
import { test } from 'vitest';
import { AppError } from '@agent-device/kernel/errors';
import type { SnapshotResult } from '@agent-device/contracts/interactor-types';
import { IOS_SIMULATOR, IPADOS_SIMULATOR } from './device-fixtures.ts';
import type { AppleRunnerProvider, RunnerCommand } from '../runner/index.ts';
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
  return createAppleInteractor(
    IOS_SIMULATOR,
    { appBundleId: 'com.example.app' },
    { env: process.env, cwd: process.cwd() },
    runnerProvider,
  );
}

test('a capture whose own command repaired foreground discloses it and keeps the fact', async () => {
  const snapshot = (await interactorServing({
    ...HEALTHY_TREE,
    targetActivation: { reason: 'stale_target', priorState: 3, otherActiveApplicationPid: 4562 },
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

test.each([
  ['iOS', IOS_SIMULATOR],
  ['iPadOS', IPADOS_SIMULATOR],
] as const)(
  'observe-only on %s forwards the policy and publishes sourced state without activation disclosure',
  async (_leaf, device) => {
    const observation = {
      mode: 'observe-only',
      activationPerformed: false,
      appState: 'runningForeground',
      appStateSource: 'xcuiapplication-state',
    };
    const commands: RunnerCommand[] = [];
    const runnerProvider: AppleRunnerProvider = {
      hasLiveSession: () => true,
      runCommand: async (_device, command) => {
        commands.push(command);
        return { ...HEALTHY_TREE, observation };
      },
    };
    const snapshot = (await createAppleInteractor(
      device,
      {},
      { env: process.env, cwd: process.cwd() },
      runnerProvider,
    ).snapshot({
      appBundleId: 'com.example.app',
      observeOnly: true,
    })) as SnapshotResult;
    assert.deepEqual(
      commands.map((command) => [command.command, command.observeOnly]),
      [['snapshot', true]],
    );
    assert.deepEqual(snapshot.observation, observation);
    assert.equal('targetActivation' in snapshot, false);
  },
);

test('observe-only refuses absent provenance rather than crediting a legacy activating runner', async () => {
  await assert.rejects(
    interactorServing(HEALTHY_TREE).snapshot({ appBundleId: 'com.example.app', observeOnly: true }),
    (error: unknown) =>
      error instanceof AppError && error.details?.reason === 'observation-unavailable',
  );
});

test('observe-only refuses a contradictory activation fact', async () => {
  await assert.rejects(
    interactorServing({
      ...HEALTHY_TREE,
      observation: {
        mode: 'observe-only',
        activationPerformed: false,
        appState: 'runningForeground',
        appStateSource: 'xcuiapplication-state',
      },
      targetActivation: { reason: 'stale_target', priorState: 3 },
    }).snapshot({ appBundleId: 'com.example.app', observeOnly: true }),
    (error: unknown) =>
      error instanceof AppError && error.details?.reason === 'observation-unavailable',
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
    priorState: 'runningBackgroundSuspended',
  });
  assert.equal(snapshot.warnings?.[0]?.includes('pid'), false);
});
