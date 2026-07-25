import assert from 'node:assert/strict';
import { test } from 'vitest';
import { closeVegaApp, openVegaApp, openVegaDevice } from '../app-lifecycle.ts';
import { createLocalVegaToolProvider, withVegaToolProvider } from '../tool-provider.ts';

test('Vega app lifecycle uses the SDK device commands with an explicit serial', async () => {
  const commands: string[][] = [];
  const provider = createLocalVegaToolProvider({
    isAvailable: async () => true,
    run: async (args) => {
      commands.push(args);
      return { exitCode: 0, stdout: '', stderr: '' };
    },
  });

  await withVegaToolProvider(provider, async () => {
    await openVegaDevice({ id: 'amazon-vvd' });
    await openVegaApp({ id: 'amazon-vvd' }, 'com.example.app.main');
    await closeVegaApp({ id: 'amazon-vvd' }, 'com.example.app.main');
  });

  assert.deepEqual(commands, [
    ['device', 'is-connected', '--device', 'amazon-vvd'],
    ['device', 'launch-app', '--device', 'amazon-vvd', '--appName', 'com.example.app.main'],
    ['device', 'terminate-app', '--device', 'amazon-vvd', '--appName', 'com.example.app.main'],
  ]);
});
