import assert from 'node:assert/strict';
import path from 'node:path';

import { PUBLIC_COMMANDS } from '../../../src/command-catalog.ts';
import { assertNonEmptyFile } from './live-assertions.ts';
import {
  type LiveContext,
  runStep,
  verifyBehavior,
  verifyCommand,
  verifyNestedReplayCommand,
} from './live-harness.ts';
import {
  assertReplayCommands,
  readReplayCommands,
  replayAttemptTimeoutMs,
  replaySuiteHostTimeoutMs,
} from '../live-device-e2e/replay-evidence.ts';

const C = PUBLIC_COMMANDS;

export async function assertFixtureReplays(context: LiveContext): Promise<void> {
  await runStep(context, 'open Android fixture for helper-backed gesture proof', [
    'open',
    context.appId,
    '--relaunch',
  ]);
  const helperSnapshot = await runStep(context, 'inspect Android helper snapshot metadata', [
    'snapshot',
    '-i',
  ]);
  assert.equal(
    helperSnapshot.json?.data?.androidSnapshot?.backend,
    'android-helper',
    JSON.stringify(helperSnapshot.json),
  );
  assert.ok(
    typeof helperSnapshot.json?.data?.androidSnapshot?.helperVersion === 'string',
    JSON.stringify(helperSnapshot.json),
  );
  await runStep(context, 'close helper snapshot session before replay', ['close']);

  const navigationReplay = path.resolve(
    'test/integration/replays/android/fixture/01-navigation-scroll.ad',
  );
  const navigationActions = readReplayCommands(navigationReplay);
  const replay = await runStep(
    context,
    'run Android fixture catalog traversal through replay',
    ['replay', navigationReplay, '--timeout', String(replayAttemptTimeoutMs(navigationReplay))],
    { timeoutMs: replayAttemptTimeoutMs(navigationReplay) + 30_000 },
  );
  assert.equal(replay.json?.data?.replayed, navigationActions.length, JSON.stringify(replay.json));
  assertReplayCommands(navigationReplay, navigationActions, [C.swipe, C.scroll]);
  verifyCommand(
    context,
    C.replay,
    'retry-free fixture catalog traversal completes through public replay',
  );
  verifyNestedReplayCommand(
    context,
    C.swipe,
    C.replay,
    'fixture replay executes direct directional swipe evidence',
  );
  verifyNestedReplayCommand(
    context,
    C.scroll,
    C.replay,
    'fixture replay executes edge-aware bottom and top traversal',
  );
  verifyBehavior(
    context,
    'long-list-scroll-recovery',
    'catalog replay reached its footer then returned to the top landmark without retry',
  );

  const checkoutReplay = path.resolve('examples/test-app/replays/checkout-form-android.ad');
  const gestureReplay = path.resolve('examples/test-app/replays/gesture-lab-android.ad');
  const junitPath = path.join(context.artifactDir, 'fixture-replays.junit.xml');
  const suiteArtifacts = path.join(context.artifactDir, 'fixture-replays');
  const suite = await runStep(
    context,
    'run Android fixture suite without retries',
    [
      'test',
      checkoutReplay,
      gestureReplay,
      '--artifacts-dir',
      suiteArtifacts,
      '--report-junit',
      junitPath,
    ],
    { timeoutMs: replaySuiteHostTimeoutMs([checkoutReplay, gestureReplay], 0) },
  );
  assert.equal(suite.json?.data?.failed, 0, JSON.stringify(suite.json));
  assert.equal(suite.json?.data?.passed, 2, JSON.stringify(suite.json));
  assertNonEmptyFile(junitPath, 'fixture JUnit');
  for (const replayPath of [checkoutReplay, gestureReplay]) {
    const result = (
      suite.json?.data?.tests as
        | Array<{ file?: unknown; replayed?: unknown; status?: unknown }>
        | undefined
    )?.find((entry) => path.resolve(String(entry.file)) === replayPath);
    assert.equal(result?.status, 'passed', JSON.stringify(suite.json));
    assert.equal(
      result?.replayed,
      readReplayCommands(replayPath).length,
      JSON.stringify(suite.json),
    );
  }
  assertReplayCommands(gestureReplay, readReplayCommands(gestureReplay), [C.gesture]);
  verifyCommand(context, C.test, 'retry-free Android fixture suite emits non-empty JUnit evidence');
  verifyNestedReplayCommand(
    context,
    C.gesture,
    C.test,
    'Android fixture suite executes planned one- and two-pointer gestures',
  );
  verifyBehavior(
    context,
    'helper-backed-gesture-recovery',
    'gesture fixture observed two-pointer pan, fling, pinch, rotate, and transform outcomes',
  );
}
