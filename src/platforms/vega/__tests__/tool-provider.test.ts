import assert from 'node:assert/strict';
import { test } from 'vitest';
import { createLocalVegaToolProvider } from '../tool-provider.ts';

test('local Vega provider owns CLI argv for each semantic operation', async () => {
  const commands: string[][] = [];
  const provider = createLocalVegaToolProvider({
    isAvailable: async () => true,
    run: async (args) => {
      commands.push(args);
      return { exitCode: 0, stdout: '', stderr: '' };
    },
  });

  await provider.version();
  await provider.listDevices();
  await provider.checkConnected('VirtualDevice');
  await provider.launchApp('VirtualDevice', 'com.example.main');
  await provider.pressRemote('VirtualDevice', 'KEY_ENTER', 800);
  await provider.terminateApp('VirtualDevice', 'com.example.main');

  assert.deepEqual(commands, [
    ['--version'],
    ['device', 'list'],
    ['device', 'is-connected', '--device', 'VirtualDevice'],
    ['device', 'launch-app', '--device', 'VirtualDevice', '--appName', 'com.example.main'],
    [
      'device',
      'run-cmd',
      '--device',
      'VirtualDevice',
      '--command',
      'inputd-cli button_press KEY_ENTER --holdDuration 800',
    ],
    ['device', 'terminate-app', '--device', 'VirtualDevice', '--appName', 'com.example.main'],
  ]);
});
