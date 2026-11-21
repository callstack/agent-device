import assert from 'node:assert/strict';
import { test } from 'vitest';
import { createVegaCommandRunnerStub } from '../command-host.fixtures.ts';
import { closeVegaApp, openVegaApp, openVegaDevice } from '../app-lifecycle.ts';
import { createVegaToolProvider, withVegaToolProvider } from '../tool-provider.ts';

test('Vega app lifecycle uses the SDK device commands with an explicit serial', async () => {
  const commands = createVegaCommandRunnerStub();

  await withVegaToolProvider(createVegaToolProvider(commands), async () => {
    await openVegaDevice({ id: 'amazon-vvd' });
    await openVegaApp({ id: 'amazon-vvd' }, 'com.example.app.main');
    await closeVegaApp({ id: 'amazon-vvd' }, 'com.example.app.main');
  });

  assert.deepEqual(
    commands.calls.map(({ args }) => args),
    [
      ['device', 'is-connected', '--device', 'amazon-vvd'],
      ['device', 'launch-app', '--device', 'amazon-vvd', '--appName', 'com.example.app.main'],
      ['device', 'terminate-app', '--device', 'amazon-vvd', '--appName', 'com.example.app.main'],
    ],
  );
});
