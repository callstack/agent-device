import assert from 'node:assert/strict';
import { test } from 'vitest';
import { createAgentDeviceClient } from '../agent-device-client.ts';
import { createTransport } from './client-transport-fixture.ts';

test('client capture.snapshot preserves unknown truncation as an omitted field', async () => {
  const setup = createTransport(async () => ({
    ok: true,
    data: {
      nodes: [],
      warnings: ['tree completeness is not independently verified'],
    },
  }));
  const client = createAgentDeviceClient(setup.config, { transport: setup.transport });

  const result = await client.capture.snapshot();

  assert.equal('truncated' in result, false);
  assert.equal(result.truncated, undefined);
});
