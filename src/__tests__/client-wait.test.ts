import assert from 'node:assert/strict';
import { test } from 'vitest';
import { createAgentDeviceClient } from '../agent-device-client.ts';
import { createTransport } from './client-transport-fixture.ts';

test('client.command.wait round-trips strict wait absent positionals', async () => {
  const setup = createTransport(async () => ({ ok: true, data: { waitedMs: 0 } }));
  const client = createAgentDeviceClient(setup.config, { transport: setup.transport });

  await client.command.wait({ absent: 'label="Removed"', timeoutMs: 2500 });

  assert.equal(setup.calls[0]?.command, 'wait');
  assert.deepEqual(setup.calls[0]?.positionals, ['absent', 'label="Removed"', '2500']);

  await assert.rejects(
    async () => await client.command.wait({ absent: 'label="Removed"', depth: 2 }),
    /wait absent does not support --depth/,
  );
  await assert.rejects(
    async () => await client.command.wait({ absent: 'label="Removed"', scope: 'Root' }),
    /wait absent does not support --scope/,
  );
});
