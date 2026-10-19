import assert from 'node:assert/strict';
import { test } from 'vitest';
import { createAgentDeviceClient } from '../agent-device-client.ts';
import { createTransport } from './client-transport-fixture.ts';

// Every system command the Node client exposes as its own method, with the
// daemon command name and positionals that method must produce. The client
// declares these one by one, so this table is what catches a method wired to
// the wrong command or losing an argument on the way to the daemon.
const SYSTEM_COMMAND_CALLS: readonly {
  method: string;
  invoke: (client: ReturnType<typeof createAgentDeviceClient>) => Promise<unknown>;
  command: string;
  positionals: string[];
  flags?: Record<string, unknown>;
}[] = [
  {
    method: 'appState',
    invoke: async (client) => await client.command.appState(),
    command: 'appstate',
    positionals: [],
  },
  {
    method: 'back',
    invoke: async (client) => await client.command.back({ mode: 'system' }),
    command: 'back',
    positionals: [],
    flags: { backMode: 'system' },
  },
  {
    method: 'home',
    invoke: async (client) => await client.command.home(),
    command: 'home',
    positionals: [],
  },
  {
    method: 'orientation',
    invoke: async (client) => await client.command.orientation({ orientation: 'landscape-left' }),
    command: 'orientation',
    positionals: ['landscape-left'],
  },
  {
    method: 'appSwitcher',
    invoke: async (client) => await client.command.appSwitcher(),
    command: 'app-switcher',
    positionals: [],
  },
  {
    method: 'keyboard',
    invoke: async (client) => await client.command.keyboard({ action: 'dismiss' }),
    command: 'keyboard',
    positionals: ['dismiss'],
  },
  {
    method: 'clipboard',
    invoke: async (client) => await client.command.clipboard({ action: 'write', text: 'hi' }),
    command: 'clipboard',
    positionals: ['write', 'hi'],
  },
  {
    method: 'tvRemote',
    invoke: async (client) => await client.command.tvRemote({ button: 'select' }),
    command: 'tv-remote',
    positionals: ['select'],
  },
];

for (const call of SYSTEM_COMMAND_CALLS) {
  test(`client.command.${call.method} sends the ${call.command} daemon command`, async () => {
    const setup = createTransport(async () => ({ ok: true, data: {} }));
    const client = createAgentDeviceClient(setup.config, { transport: setup.transport });

    await call.invoke(client);

    assert.equal(setup.calls.length, 1);
    assert.equal(setup.calls[0]?.command, call.command);
    assert.deepEqual(setup.calls[0]?.positionals, call.positionals);
    for (const [flag, value] of Object.entries(call.flags ?? {})) {
      assert.deepEqual(setup.calls[0]?.flags?.[flag], value);
    }
  });
}
