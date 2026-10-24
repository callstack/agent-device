import assert from 'node:assert/strict';
import { test } from 'vitest';
import { createAgentDeviceClient } from '../agent-device-client.ts';
import { createTransport } from './client-transport-fixture.ts';

test('interactions.pan sends holdMs as structured gesture input', async () => {
  const setup = createTransport(async () => ({ ok: true, data: { message: 'Panned' } }));
  const client = createAgentDeviceClient(setup.config, { transport: setup.transport });

  await client.interactions.pan({ x: 100, y: 200, dx: 0, dy: 240, durationMs: 400, holdMs: 600 });

  assert.deepEqual(
    setup.calls.map(({ command, positionals, input }) => ({ command, positionals, input })),
    [
      {
        command: 'gesture',
        positionals: [],
        input: {
          kind: 'pan',
          origin: { x: 100, y: 200 },
          delta: { x: 0, y: 240 },
          durationMs: 400,
          holdMs: 600,
        },
      },
    ],
  );
});
