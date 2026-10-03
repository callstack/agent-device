import assert from 'node:assert/strict';
import { test } from 'vitest';
import { assertRpcError, assertRpcOk } from './assertions.ts';
import { PROVIDER_SCENARIO_IOS_SIMULATOR } from './fixtures.ts';
import { createProviderScenarioHarness, withProviderScenarioResource } from './harness.ts';
import {
  createAppleRunnerProviderFromTranscript,
  createRecordingAppleToolProvider,
  simctlDeviceLifecycleHandler,
} from './providers.ts';
import { createProviderTranscript, type ProviderScenarioProviderEntry } from './transcript.ts';

// promotedTarget readiness (press/click/longpress poll for the target to exist and become
// actionable before refusing): end-to-end proof through the real daemon stack, not the plain
// runtime harness. The press route captures through the interaction backend, which keeps no
// selector capture cache, so every poll reaches the runner transcript below.

const APP = 'com.example.app';
const DEVICE_ID = PROVIDER_SCENARIO_IOS_SIMULATOR.id;

const APPLICATION_ONLY_NODES = [
  {
    index: 0,
    type: 'Application',
    label: 'Example',
    rect: { x: 0, y: 0, width: 400, height: 800 },
  },
];

const CONTINUE_BUTTON_NODES = [
  {
    index: 0,
    type: 'Application',
    label: 'Example',
    rect: { x: 0, y: 0, width: 400, height: 800 },
  },
  {
    index: 1,
    parentIndex: 0,
    type: 'Button',
    label: 'Continue',
    hittable: true,
    rect: { x: 100, y: 300, width: 200, height: 44 },
  },
];

function snapshotEntry(nodes: readonly unknown[]): ProviderScenarioProviderEntry {
  return {
    command: 'ios.runner.snapshot',
    deviceId: DEVICE_ID,
    platform: 'apple',
    result: { nodes, truncated: false },
  };
}

function repeatSnapshotEntry(nodes: readonly unknown[]): ProviderScenarioProviderEntry {
  return { ...snapshotEntry(nodes), repeat: true };
}

function tapEntry(x: number, y: number): ProviderScenarioProviderEntry {
  return {
    command: 'ios.runner.tap',
    deviceId: DEVICE_ID,
    platform: 'apple',
    result: { x, y },
  };
}

async function withPressReadinessDaemon(
  entries: readonly ProviderScenarioProviderEntry[],
  run: (
    daemon: Awaited<ReturnType<typeof createProviderScenarioHarness>>,
    transcript: ReturnType<typeof createProviderTranscript>,
  ) => Promise<void>,
): Promise<void> {
  const runnerTranscript = createProviderTranscript(entries);
  const appleRunnerProvider = createAppleRunnerProviderFromTranscript(
    runnerTranscript,
    'ios.runner',
  );
  const appleTool = createRecordingAppleToolProvider({
    simctl: simctlDeviceLifecycleHandler('com.apple.CoreSimulator.SimRuntime.iOS-18-0', [
      { name: PROVIDER_SCENARIO_IOS_SIMULATOR.name, udid: DEVICE_ID },
    ]),
  });

  await withProviderScenarioResource(
    async () =>
      await createProviderScenarioHarness({
        appleRunnerProvider: () => appleRunnerProvider,
        appleToolProvider: () => appleTool.provider,
        deviceInventoryProvider: async () => [PROVIDER_SCENARIO_IOS_SIMULATOR],
      }),
    async (daemon) => {
      const open = await daemon.callCommand('open', [APP], { platform: 'ios', udid: DEVICE_ID });
      assertRpcOk(open);
      await run(daemon, runnerTranscript);
    },
  );
}

test('press waits for a selector missing on the first two captures, then taps once it appears', async () => {
  await withPressReadinessDaemon(
    [
      // Poll 1: interactive capture, then the interactive->full fallback — both miss because the
      // button is not in the tree yet.
      snapshotEntry(APPLICATION_ONLY_NODES),
      snapshotEntry(APPLICATION_ONLY_NODES),
      // Poll 2 onward: the button has appeared.
      repeatSnapshotEntry(CONTINUE_BUTTON_NODES),
      tapEntry(200, 322),
    ],
    async (daemon, transcript) => {
      // Never CLI- or model-writable, so the scenario supplies it directly as a request flag.
      const press = await daemon.callCommand('press', ['label=Continue'], {
        readinessTimeoutMs: 2_000,
      });
      const data = assertRpcOk(press);
      assert.equal(data.x, 200);
      assert.equal(data.y, 322);

      const commands = transcript.calls.map((call) => call.command);
      const tapIndex = commands.indexOf('ios.runner.tap');
      assert.ok(tapIndex >= 0, 'expected the runner to receive a tap');
      assert.equal(
        commands.filter((command) => command === 'ios.runner.tap').length,
        1,
        'expected exactly one tap dispatch',
      );
      // Every snapshot call precedes the single tap: the loop never taps before a poll resolves.
      assert.ok(
        commands.slice(0, tapIndex).every((command) => command === 'ios.runner.snapshot'),
        `expected only snapshot calls before the tap, got ${JSON.stringify(commands)}`,
      );
      assert.ok(
        tapIndex >= 3,
        `expected at least 3 snapshot calls before the tap (interactive+fallback misses, then a resolved poll), got ${tapIndex}`,
      );

      transcript.assertComplete();
    },
  );
});

test('press whose target appears on the third poll reports readiness with polls 3 on the success response', async () => {
  await withPressReadinessDaemon(
    [
      snapshotEntry(APPLICATION_ONLY_NODES),
      snapshotEntry(APPLICATION_ONLY_NODES),
      snapshotEntry(APPLICATION_ONLY_NODES),
      snapshotEntry(APPLICATION_ONLY_NODES),
      repeatSnapshotEntry(CONTINUE_BUTTON_NODES),
      tapEntry(200, 322),
    ],
    async (daemon) => {
      const press = await daemon.callCommand('press', ['label=Continue'], {
        readinessTimeoutMs: 2_000,
      });
      const data = assertRpcOk(press);
      const readiness = data.readiness as { polls: number; waitedMs: number } | undefined;
      assert.equal(readiness?.polls, 3);
      assert.equal(typeof readiness?.waitedMs, 'number');
    },
  );
});

test('press whose first capture hits carries no readiness field even with a readiness budget', async () => {
  await withPressReadinessDaemon(
    [snapshotEntry(CONTINUE_BUTTON_NODES), tapEntry(200, 322)],
    async (daemon) => {
      const press = await daemon.callCommand('press', ['label=Continue'], {
        readinessTimeoutMs: 2_000,
      });
      const data = assertRpcOk(press);
      assert.equal('readiness' in data, false);
    },
  );
});

test('press fails with the standard no-match error, carrying readiness evidence, when the target never appears', async () => {
  await withPressReadinessDaemon([repeatSnapshotEntry(APPLICATION_ONLY_NODES)], async (daemon) => {
    // No fake clock is wired into this daemon-composed runtime path (AgentDeviceRuntime.clock is
    // never set by daemon composition), so this genuinely spends the ~2s promotedTarget readiness
    // budget in wall-clock time before failing.
    const press = await daemon.callCommand('press', ['label=Continue'], {
      readinessTimeoutMs: 2_000,
    });
    const error = assertRpcError(press, 'COMMAND_FAILED', /Selector did not match/);
    const details = error.details as {
      reason: unknown;
      readiness: { polls: number; waitedMs: number; end: string };
    };
    assert.equal(details.reason, 'selector_not_found');
    assert.ok(details.readiness.polls >= 2, `expected >=2 polls, got ${details.readiness.polls}`);
    assert.ok(
      details.readiness.waitedMs >= 2000,
      `expected >=2000ms waited, got ${details.readiness.waitedMs}`,
    );
    assert.equal(details.readiness.end, 'expired');
  });
}, 15_000);

test('press resolving on the first capture costs exactly one snapshot call (zero readiness cost on the success path)', async () => {
  await withPressReadinessDaemon(
    [snapshotEntry(CONTINUE_BUTTON_NODES), tapEntry(200, 322)],
    async (daemon) => {
      const press = await daemon.callCommand('press', ['label=Continue']);
      assertRpcOk(press);
    },
  );
});

// (d) Agent misses are usually a wrong selector, so fast feedback beats absorbing a render race.
// Without an explicit readinessTimeoutMs (never CLI- or model-writable), a miss takes the
// one-attempt path: exactly one capture-and-resolve attempt (the interactive-then-full-capture
// fallback, not the readiness loop's repeated polling), and no readiness evidence to attach.
test('press without a readinessTimeoutMs flag fails on the first capture attempt, with no readiness poll', async () => {
  await withPressReadinessDaemon(
    // Interactive capture, then the interactive->full fallback — both miss, exactly like poll 1 of
    // the readiness loop above, because this IS that same one attempt, just never repeated.
    [snapshotEntry(APPLICATION_ONLY_NODES), snapshotEntry(APPLICATION_ONLY_NODES)],
    async (daemon, transcript) => {
      const callsBeforePress = transcript.calls.length;
      const press = await daemon.callCommand('press', ['label=Continue']);
      const error = assertRpcError(press, 'COMMAND_FAILED', /Selector did not match/);
      const details = error.details as { reason: unknown; readiness: unknown };
      assert.equal(details.reason, 'selector_not_found');
      assert.equal(details.readiness, undefined);

      const commands = transcript.calls.slice(callsBeforePress).map((call) => call.command);
      assert.deepEqual(commands, ['ios.runner.snapshot', 'ios.runner.snapshot']);
      transcript.assertComplete();
    },
  );
});

test('press ends the wait at once on a sparse capture with capture_sparse, and never taps', async () => {
  await withPressReadinessDaemon(
    [
      {
        command: 'ios.runner.snapshot',
        deviceId: DEVICE_ID,
        platform: 'apple',
        repeat: true,
        result: {
          nodes: APPLICATION_ONLY_NODES,
          truncated: false,
          snapshotQuality: {
            state: 'sparse',
            backend: 'tree',
            reasonCode: 'sparse-tree',
          },
        },
      },
    ],
    async (daemon, transcript) => {
      const callsBeforePress = transcript.calls.length;
      const startedAt = Date.now();
      const press = await daemon.callCommand('press', ['label=Continue'], {
        readinessTimeoutMs: 2_000,
      });
      const error = assertRpcError(press, 'COMMAND_FAILED', /sparse capture/);
      const details = error.details as {
        reason: unknown;
        snapshotQuality: { state: string };
        readiness: { polls: number; end: string };
      };
      assert.equal(details.reason, 'capture_sparse');
      assert.equal((error.details as { dispatched?: unknown }).dispatched, 'no');
      assert.equal(details.snapshotQuality.state, 'sparse');
      assert.equal(details.readiness.end, 'sparse');
      assert.ok(Date.now() - startedAt < 1_500, 'a sparse capture must not burn the budget');
      const commands = transcript.calls.slice(callsBeforePress).map((call) => call.command);
      assert.ok(!commands.includes('ios.runner.tap'), 'no tap on a sparse capture');
    },
  );
});
