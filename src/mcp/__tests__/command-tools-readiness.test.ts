import assert from 'node:assert/strict';
import { test } from 'vitest';
import { createAgentDeviceClient } from '../../agent-device-client.ts';
import { createTransport } from '../../__tests__/client-transport-fixture.ts';
import { createCommandToolExecutor } from '../command-tools.ts';

test('MCP press returns the daemon data.readiness in structuredContent', async () => {
  const readiness = { polls: 2, waitedMs: 180 };
  const setup = createTransport(async () => ({ ok: true, data: { ref: '@e1', readiness } }));
  const executor = createCommandToolExecutor({
    createClient: () => createAgentDeviceClient(setup.config, { transport: setup.transport }),
  });

  const result = await executor.execute('press', {
    target: { kind: 'selector', selector: 'label=Continue' },
  });

  assert.equal(result.isError, false);
  assert.deepEqual(result.structuredContent?.readiness, readiness);
});
