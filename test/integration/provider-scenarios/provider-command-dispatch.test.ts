import { expect, test } from 'vitest';
import { respondToAndroidSettingsAdbCommand } from './android-world.ts';
import { simctlDeviceLifecycleHandler } from './providers.ts';

test('simulator inventory fixture rejects unmodeled simctl commands', async () => {
  const run = simctlDeviceLifecycleHandler('com.apple.CoreSimulator.SimRuntime.iOS-18-0', []);

  await expect(run(['delete', 'unexpected-device'], {})).rejects.toThrow(
    'Unscripted Apple provider call: simctl delete unexpected-device',
  );
});

test('Android settings fixture rejects unmodeled adb commands', () => {
  expect(() =>
    respondToAndroidSettingsAdbCommand(
      ['shell', 'echo', 'unexpected-provider-command'],
      '',
      '',
      {},
    ),
  ).toThrow('Unscripted Android provider call: shell echo unexpected-provider-command');
});
