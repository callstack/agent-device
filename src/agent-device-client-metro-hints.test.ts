import { afterEach, test, vi } from 'vitest';
import assert from 'node:assert/strict';
import * as daemonResolution from '@agent-device/daemon-contracts/daemon-resolution';
import { createAgentDeviceClient } from './agent-device-client.ts';
import { createTransport } from './__tests__/client-transport-fixture.ts';

afterEach(() => vi.restoreAllMocks());

for (const command of ['open', 'close'] as const) {
  test(`${command} succeeds when optional Metro hint scope resolution fails`, async () => {
    const setup = createTransport(async () => ({ ok: true, data: {} }));
    const client = createAgentDeviceClient(setup.config, { transport: setup.transport });
    vi.spyOn(daemonResolution, 'resolveDaemonPaths').mockImplementation(() => {
      throw new Error('home directory unavailable');
    });
    const result =
      command === 'open'
        ? await client.apps.open({ app: 'com.example.app', platform: 'ios' })
        : await client.sessions.close();
    assert.equal(result.session, setup.config.session);
    assert.equal(setup.calls[0]?.command, command);
  });
}
