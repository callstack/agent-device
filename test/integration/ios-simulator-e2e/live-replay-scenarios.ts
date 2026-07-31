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
  const navigationReplay = path.resolve(
    'test/integration/replays/ios/fixture/01-navigation-scroll.ad',
  );
  const navigationActions = readReplayCommands(navigationReplay);
  const navigationDaemonTimeoutMs = replayAttemptTimeoutMs(navigationReplay) + 30_000;
  const navigation = await runStep(
    context,
    'run navigation replay through public command',
    ['replay', navigationReplay, '--timeout', String(navigationDaemonTimeoutMs)],
    { timeoutMs: navigationDaemonTimeoutMs + 30_000 },
  );
  assert.equal(
    navigation.json?.data?.replayed,
    navigationActions.length,
    JSON.stringify(navigation.json),
  );
  assertReplayCommands(navigationReplay, navigationActions, [C.swipe]);
  verifyCommand(context, C.replay, 'public replay completes the navigation fixture');
  verifyNestedReplayCommand(
    context,
    C.swipe,
    C.replay,
    'direction canary proves both compact-safe swipes moved content',
  );
  verifyBehavior(
    context,
    'long-list-scroll-recovery',
    'replay proved down, bottom footer, up, and top rediscovery in one fixture journey',
  );

  const checkoutReplay = path.resolve(
    'test/integration/replays/ios/fixture/02-checkout-release.ad',
  );
  const gestureReplay = path.resolve('examples/test-app/replays/gesture-lab.ad');
  const { commandsByScript } = await runLiveReplayTestSuite({
    context,
    runStep,
    step: 'run fixture suite through public test command',
    scripts: [checkoutReplay, gestureReplay],
    retries: 2,
  });
  for (const [replayPath, expectedCommands] of [
    [checkoutReplay, [C.swipe]],
    [gestureReplay, [C.gesture]],
  ] as const) {
    assertReplayCommands(replayPath, commandsByScript.get(replayPath) ?? [], expectedCommands);
  }
  verifyNestedReplayCommand(
    context,
    C.gesture,
    C.test,
    'gesture fixture counters prove pan/fling/pinch/rotate/transform',
  );
  verifyCommand(context, C.test, 'two fixture scripts pass as a suite and emit non-empty JUnit');
}
