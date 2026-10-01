import assert from 'node:assert/strict';
import { test } from 'vitest';
import { AppError } from '@agent-device/kernel/errors';
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
    runCommand: async () => ({
      ...payload,
      supportsObserveOnlySnapshot: true,
      runnerSessionId: 'observation-runner',
    }),
  };
  return createAppleInteractor(IOS_SIMULATOR, { appBundleId: 'com.example.app' }, runnerProvider);
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

test('observe-only forwards the policy and publishes sourced state without activation disclosure', async () => {
  const observation = {
    mode: 'observe-only',
    activationPerformed: false,
    appState: 'runningForeground',
    appStateSource: 'xcuiapplication-state',
  };
  const commands: unknown[] = [];
  const runnerProvider: AppleRunnerProvider = {
    hasLiveSession: () => true,
    runCommand: async (_device, command, options) => {
      commands.push(command);
      if (command.command === 'snapshot') {
        assert.equal(options?.expectedRunnerSessionId, 'observation-runner');
      }
      return {
        ...HEALTHY_TREE,
        observation,
        supportsObserveOnlySnapshot: true,
        runnerSessionId: 'observation-runner',
      };
    },
  };
  const snapshot = (await createAppleInteractor(IOS_SIMULATOR, {}, runnerProvider).snapshot({
    appBundleId: 'com.example.app',
    observeOnly: true,
  })) as SnapshotResult;
  assert.equal((commands[1] as { observeOnly?: boolean }).observeOnly, true);
  assert.deepEqual(snapshot.observation, observation);
  assert.equal('targetActivation' in snapshot, false);
});

test.each([
  { supportsObserveOnlySnapshot: false, runnerSessionId: 'observation-runner' },
  { supportsObserveOnlySnapshot: true },
])(
  'observe-only rejects an unbound capability response before snapshot dispatch: %j',
  async (capabilities) => {
    const commands: string[] = [];
    const runnerProvider: AppleRunnerProvider = {
      hasLiveSession: () => true,
      runCommand: async (_device, command) => {
        commands.push(command.command);
        return capabilities;
      },
    };
    await assert.rejects(
      createAppleInteractor(IOS_SIMULATOR, {}, runnerProvider).snapshot({
        appBundleId: 'com.example.app',
        observeOnly: true,
      }),
      (error: unknown) =>
        error instanceof AppError && error.details?.reason === 'observation-unavailable',
    );
    assert.deepEqual(commands, ['uptime']);
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
