import assert from 'node:assert/strict';
import { test } from 'vitest';
import { createAgentDeviceClient } from '../../agent-device-client.ts';
import { createTransport } from '../../__tests__/client-transport-fixture.ts';
import { createCommandToolExecutor, listCommandTools } from '../command-tools.ts';

test('MCP gesture tool exposes tap contacts bounded to 2 to 5 points', () => {
  const gesture = listCommandTools().find((tool) => tool.name === 'gesture');
  assert.ok(gesture);
  assert.deepEqual(gesture.inputSchema.properties?.points, {
    type: 'array',
    description: 'Tap contact points, held together for holdMs.',
    items: {
      type: 'object',
      description: 'One contact point.',
      properties: { x: { type: 'number' }, y: { type: 'number' } },
      required: ['x', 'y'],
      additionalProperties: false,
    },
    minItems: 2,
    maxItems: 5,
  });
  assert.deepEqual(gesture.inputSchema.properties?.holdMs, {
    type: 'integer',
    description: 'Tap contact hold duration.',
    minimum: 16,
    maximum: 10_000,
  });
});

test('MCP gesture tap sends its contacts and series to the daemon', async () => {
  const setup = createTransport(() => ({ ok: true, data: { message: 'Tapped 2 points 3 times' } }));
  const executor = createCommandToolExecutor({
    createClient: () => createAgentDeviceClient(setup.config, { transport: setup.transport }),
  });
  const input = {
    kind: 'tap',
    points: [
      { x: 80, y: 300 },
      { x: 200, y: 450 },
    ],
    holdMs: 40,
    count: 3,
    pauseMs: 100,
  };
  const result = await executor.execute('gesture', input);
  assert.equal(result.isError, false);
  assert.equal(setup.calls.length, 1);
  assert.equal(setup.calls[0]?.command, 'gesture');
  assert.deepEqual(setup.calls[0]?.positionals, []);
  assert.deepEqual(setup.calls[0]?.input, input);
});
