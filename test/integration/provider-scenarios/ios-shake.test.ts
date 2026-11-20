import assert from 'node:assert/strict';
import { test } from 'vitest';
import { PROVIDER_SCENARIO_IOS_SIMULATOR } from './fixtures.ts';
import { createProviderScenarioHarness } from './harness.ts';
import { createRecordingAppleToolProvider } from './providers.ts';

test('Provider-backed integration iOS shake posts the simulator shake notification through simctl', async () => {
  const ok = { stdout: '', stderr: '', exitCode: 0 };
  const tool = createRecordingAppleToolProvider({
    simctl: async (args) => {
      if (args[0] !== 'list') return ok;
      return {
        ...ok,
        stdout: JSON.stringify({
          devices: {
            'iOS 18.5': [{ udid: PROVIDER_SCENARIO_IOS_SIMULATOR.id, state: 'Booted' }],
          },
        }),
      };
    },
  });
  const runnerCommands: unknown[] = [];
  const daemon = await createProviderScenarioHarness({
    deviceInventoryProvider: async () => [PROVIDER_SCENARIO_IOS_SIMULATOR],
    appleRunnerProvider: () => ({
      hasLiveSession: () => true,
      runCommand: async (_device, command) => {
        runnerCommands.push(command);
        return {};
      },
    }),
    appleToolProvider: () => tool.provider,
  });
  try {
    await daemon.client().apps.open({
      app: 'com.example.demo',
      platform: 'ios',
      udid: PROVIDER_SCENARIO_IOS_SIMULATOR.id,
    });
    tool.calls.splice(0);
    runnerCommands.splice(0);

    const result = await daemon.client().command.shake({
      platform: 'ios',
      udid: PROVIDER_SCENARIO_IOS_SIMULATOR.id,
    });

    assert.deepEqual(result, { action: 'shake', message: 'Shook the device' });
    assert.deepEqual(
      tool.calls.filter((call) => call.includes('notifyutil')),
      [
        [
          'simctl',
          'spawn',
          PROVIDER_SCENARIO_IOS_SIMULATOR.id,
          'notifyutil',
          '-p',
          'com.apple.UIKit.SimulatorShake',
        ],
      ],
    );
    // The shake is host-side: it must not start or wait for the XCTest runner.
    assert.deepEqual(runnerCommands, []);
  } finally {
    await daemon.close();
  }
});
