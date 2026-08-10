import assert from 'node:assert/strict';
import path from 'node:path';

import { PUBLIC_COMMANDS } from '../../../src/command-catalog.ts';
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
} from '../live-device-e2e/replay-evidence.ts';
import { runLiveReplayTestSuite } from '../live-device-e2e/replay-suite.ts';

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
  const dragReplay = path.resolve('examples/test-app/replays/drag-android.ad');
  const { commandsByScript } = await runLiveReplayTestSuite({
    context,
    runStep,
    step: 'run Android fixture suite without retries',
    scripts: [checkoutReplay, gestureReplay, dragReplay],
  });
  assertReplayCommands(gestureReplay, commandsByScript.get(gestureReplay) ?? [], [C.gesture]);
  assertReplayCommands(dragReplay, commandsByScript.get(dragReplay) ?? [], [C.gesture]);
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
