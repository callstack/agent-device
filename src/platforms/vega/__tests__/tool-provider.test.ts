import assert from 'node:assert/strict';
import { test } from 'vitest';
import { createLocalVegaToolProvider } from '../tool-provider.ts';

test('local Vega provider owns CLI argv for each semantic operation', async () => {
  const commands: Array<[string, string[]]> = [];
  const provider = createLocalVegaToolProvider({
    whichCommand: async (cmd) => cmd === 'vega',
    runCommand: async (cmd, args) => {
      commands.push([cmd, args]);
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
    ['vega', ['--version']],
    ['vega', ['device', 'list']],
    ['vega', ['device', 'is-connected', '--device', 'VirtualDevice']],
    [
      'vega',
      ['device', 'launch-app', '--device', 'VirtualDevice', '--appName', 'com.example.main'],
    ],
    [
      'vega',
      [
        'device',
        'run-cmd',
        '--device',
        'VirtualDevice',
        '--command',
        'inputd-cli button_press KEY_ENTER --holdDuration 800',
      ],
    ],
    [
      'vega',
      ['device', 'terminate-app', '--device', 'VirtualDevice', '--appName', 'com.example.main'],
    ],
  ]);
});

test('Vega provider coerces unchecked executor output at the boundary', async () => {
  const provider = createLocalVegaToolProvider({
    whichCommand: async () => true,
    runCommand: async () =>
      ({
        exitCode: 'bad',
        stdout: 42,
        stderr: null,
      }) as never,
  });

  assert.deepEqual(await provider.listDevices(), {
    exitCode: 1,
    stdout: '42',
    stderr: '',
  });
});
