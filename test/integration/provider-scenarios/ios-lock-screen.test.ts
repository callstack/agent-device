import assert from 'node:assert/strict';
import { test } from 'vitest';
import { PROVIDER_SCENARIO_IOS_SIMULATOR } from './fixtures.ts';
import { createProviderScenarioHarness } from './harness.ts';
import { createRecordingAppleToolProvider } from './providers.ts';

test('Provider-backed integration iOS lock-screen sends lockScreen, unlockScreen, and lockScreenStatus to the runner without activating the app', async () => {
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
  const runnerCommands: string[] = [];
  const daemon = await createProviderScenarioHarness({
    deviceInventoryProvider: async () => [PROVIDER_SCENARIO_IOS_SIMULATOR],
    appleRunnerProvider: () => ({
      hasLiveSession: () => true,
      runCommand: async (_device, command) => {
        runnerCommands.push(command.command);
        return command.command === 'lockScreenStatus' ? { locked: true } : {};
      },
    }),
    appleToolProvider: () => tool.provider,
  });
  const selection = { platform: 'ios', udid: PROVIDER_SCENARIO_IOS_SIMULATOR.id } as const;
  try {
    await daemon.client().apps.open({ app: 'com.example.demo', ...selection });
    runnerCommands.splice(0);
    tool.calls.splice(0);

    assert.deepEqual(await daemon.client().command.lockScreen({ action: 'lock', ...selection }), {
      action: 'lock-screen',
      state: 'locked',
      message: 'Locked the screen',
    });
    assert.deepEqual(await daemon.client().command.lockScreen({ action: 'unlock', ...selection }), {
      action: 'lock-screen',
      state: 'unlocked',
      message: 'Unlocked the screen',
    });
    assert.deepEqual(await daemon.client().command.lockScreen({ action: 'status', ...selection }), {
      action: 'lock-screen',
      state: 'locked',
      message: 'The screen is locked',
    });
    // Activating the session app would dismiss the lock screen the first command shows, and the
    // lock screen a status read reports on.
    assert.deepEqual(runnerCommands, ['lockScreen', 'unlockScreen', 'lockScreenStatus']);
    assert.deepEqual(
      tool.calls.filter((call) => call.includes('launch')),
      [],
    );
  } finally {
    await daemon.close();
  }
});
