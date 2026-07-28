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
} from './replay-evidence.ts';

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

  const junitPath = path.join(context.artifactDir, 'fixture-replays.junit.xml');
  const suiteArtifacts = path.join(context.artifactDir, 'fixture-replays');
  const checkoutReplay = path.resolve(
    'test/integration/replays/ios/fixture/02-checkout-release.ad',
  );
  const gestureReplay = path.resolve('examples/test-app/replays/gesture-lab.ad');
  const suiteRetries = 2;
  const suite = await runStep(
    context,
    'run fixture suite through public test command',
    [
      'test',
      checkoutReplay,
      gestureReplay,
      '--retries',
      String(suiteRetries),
      '--artifacts-dir',
      suiteArtifacts,
      '--report-junit',
      junitPath,
    ],
    {
      timeoutMs: replaySuiteHostTimeoutMs([checkoutReplay, gestureReplay], suiteRetries),
    },
  );
  assert.equal(suite.json?.data?.failed, 0, JSON.stringify(suite.json));
  assert.equal(suite.json?.data?.passed, 2, JSON.stringify(suite.json));
  const suiteTests = Array.isArray(suite.json?.data?.tests) ? suite.json.data.tests : [];
  for (const [replayPath, expectedCommands] of [
    [checkoutReplay, [C.swipe]],
    [gestureReplay, [C.gesture]],
  ] as const) {
    const commands = readReplayCommands(replayPath);
    const result = suiteTests.find(
      (entry: { file?: unknown }) => path.resolve(String(entry.file)) === replayPath,
    );
    assert.equal(result?.status, 'passed', JSON.stringify(suite.json));
    assert.equal(result?.replayed, commands.length, JSON.stringify(result));
    assertReplayCommands(replayPath, commands, expectedCommands);
  }
  assertNonEmptyFile(junitPath, 'fixture JUnit');
  verifyNestedReplayCommand(
    context,
    C.gesture,
    C.test,
    'gesture fixture counters prove pan/fling/pinch/rotate/transform',
  );
  verifyCommand(context, C.test, 'two fixture scripts pass as a suite and emit non-empty JUnit');
}
