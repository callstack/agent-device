import assert from 'node:assert/strict';
import { test } from 'vitest';
import type { AgentDeviceClient } from '../../client/client-types.ts';
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

test('MCP gesture tap reaches the client tapGesture method with its contacts and series', async () => {
  const calls: unknown[] = [];
  const executor = createCommandToolExecutor({
    createClient: () =>
      ({
        interactions: {
          tapGesture: async (options: unknown) => {
            calls.push(options);
            return { message: 'Tapped 2 points 3 times' };
          },
        },
      }) as unknown as AgentDeviceClient,
  });

  const result = await executor.execute('gesture', {
    kind: 'tap',
    points: [
      { x: 80, y: 300 },
      { x: 200, y: 450 },
    ],
    holdMs: 40,
    count: 3,
    pauseMs: 100,
  });

  assert.equal(result.isError, false);
  assert.deepEqual(calls, [
    {
      points: [
        { x: 80, y: 300 },
        { x: 200, y: 450 },
      ],
      holdMs: 40,
      count: 3,
      pauseMs: 100,
    },
  ]);
});
