import assert from 'node:assert/strict';
import { test } from 'vitest';
import { assertRpcError } from './assertions.ts';
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
  // Successive lockScreenStatus answers: locked, unlocked, then one without a lock state.
  const statusAnswers: Record<string, unknown>[] = [{ locked: true }, { locked: false }, {}];
  const daemon = await createProviderScenarioHarness({
    deviceInventoryProvider: async () => [PROVIDER_SCENARIO_IOS_SIMULATOR],
    appleRunnerProvider: () => ({
      hasLiveSession: () => true,
      runCommand: async (_device, command) => {
        runnerCommands.push(command.command);
        return command.command === 'lockScreenStatus' ? statusAnswers.shift()! : {};
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
    assert.deepEqual(await daemon.client().command.lockScreen({ action: 'status', ...selection }), {
      action: 'lock-screen',
      state: 'unlocked',
      message: 'The screen is unlocked',
    });
    // An answer without a lock state is an error, never unlocked.
    assertRpcError(
      await daemon.callCommand('lock-screen', ['status'], selection),
      500,
      'COMMAND_FAILED',
      /no lock state/,
    );
    // Activating the session app would dismiss the lock screen the first command shows, and the
    // lock screen a status read reports on.
    assert.deepEqual(runnerCommands, [
      'lockScreen',
      'unlockScreen',
      'lockScreenStatus',
      'lockScreenStatus',
      'lockScreenStatus',
    ]);
    assert.deepEqual(
      tool.calls.filter((call) => call.includes('launch')),
      [],
    );
  } finally {
    await daemon.close();
  }
});
