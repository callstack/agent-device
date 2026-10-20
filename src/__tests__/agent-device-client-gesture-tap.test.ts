import assert from 'node:assert/strict';
import { test } from 'vitest';
import { createAgentDeviceClient } from '../agent-device-client.ts';
import { createTransport } from './client-transport-fixture.ts';

test('interactions.tapGesture sends its contacts and series as structured gesture input', async () => {
  const setup = createTransport(async () => ({ ok: true, data: { message: 'Tapped' } }));
  const client = createAgentDeviceClient(setup.config, { transport: setup.transport });

  await client.interactions.tapGesture({
    points: [
      { x: 80, y: 300 },
      { x: 200, y: 450 },
    ],
    holdMs: 40,
    count: 3,
    pauseMs: 100,
  });

  assert.deepEqual(
    setup.calls.map(({ command, positionals, input }) => ({ command, positionals, input })),
    [
      {
        command: 'gesture',
        positionals: [],
        input: {
          kind: 'tap',
          points: [
            { x: 80, y: 300 },
            { x: 200, y: 450 },
          ],
          holdMs: 40,
          count: 3,
          pauseMs: 100,
        },
      },
    ],
  );
});
