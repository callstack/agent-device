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

function tapEntry(x: number, y: number): ProviderScenarioProviderEntry {
  return {
    command: 'ios.runner.tap',
    deviceId: DEVICE_ID,
    platform: 'apple',
    result: { x, y },
  };
}

async function withPressSelectorDaemon(
  entries: readonly ProviderScenarioProviderEntry[],
  run: (
    daemon: Awaited<ReturnType<typeof createProviderScenarioHarness>>,
    transcript: ReturnType<typeof createProviderTranscript>,
  ) => Promise<void>,
): Promise<void> {
  // The scripted open is not read back, so the first capture after it settles over a quiet pair of
  // reads. A snapshot consumes that pair here, keeping the scenario's own captures one-for-one.
  const runnerTranscript = createProviderTranscript([
    snapshotEntry(APPLICATION_ONLY_NODES),
    snapshotEntry(APPLICATION_ONLY_NODES),
    ...entries,
  ]);
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
      assertRpcOk(await daemon.callCommand('snapshot'));
      await run(daemon, runnerTranscript);
    },
  );
}

test('press resolving on the first capture costs exactly one snapshot call', async () => {
  await withPressSelectorDaemon(
    [snapshotEntry(CONTINUE_BUTTON_NODES), tapEntry(200, 322)],
    async (daemon, transcript) => {
      const callsBeforePress = transcript.calls.length;
      const press = await daemon.callCommand('press', ['label=Continue']);
      assertRpcOk(press);
      assert.deepEqual(
        transcript.calls.slice(callsBeforePress).map((call) => call.command),
        ['ios.runner.snapshot', 'ios.runner.tap'],
      );
      transcript.assertComplete();
    },
  );
});

test('press refuses a selector miss after one interactive and full capture attempt', async () => {
  await withPressSelectorDaemon(
    [snapshotEntry(APPLICATION_ONLY_NODES), snapshotEntry(APPLICATION_ONLY_NODES)],
    async (daemon, transcript) => {
      const callsBeforePress = transcript.calls.length;
      const press = await daemon.callCommand('press', ['label=Continue']);
      const error = assertRpcError(press, 500, 'COMMAND_FAILED', /Selector did not match/);
      const details = error.details as { reason: unknown; dispatched?: unknown };
      assert.equal(details.reason, 'selector_not_found');
      assert.equal(details.dispatched, 'no');

      const commands = transcript.calls.slice(callsBeforePress).map((call) => call.command);
      assert.deepEqual(commands, ['ios.runner.snapshot', 'ios.runner.snapshot']);
      transcript.assertComplete();
    },
  );
});
