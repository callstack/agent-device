import { describe, expect, test } from 'vitest';
import type { CliFlags } from '@agent-device/contracts/command';
import type { AgentDeviceClient } from '../../client/client-types.ts';
import { gestureCliReaders } from './gesture.ts';
import { interactionCommandFamily } from './index.ts';

const NO_FLAGS = {} as CliFlags;

/**
 * The gesture `run` projection is exercised through the family's executable
 * definition — the same `invoke` path the CLI/daemon/MCP surfaces dispatch
 * through — with a client that records which interaction method each gesture
 * kind lands on and with which options.
 */
function recordingGestureClient(calls: Array<{ method: string; options: unknown }>) {
  const interactions = new Proxy(
    {},
    {
      get: (_target, method: string) => async (options: unknown) => {
        calls.push({ method, options });
        return { ok: true };
      },
    },
  );
  return { interactions } as unknown as AgentDeviceClient;
}

function gestureDefinition() {
  const definition = interactionCommandFamily.definitions.find((entry) => entry.name === 'gesture');
  if (!definition) throw new Error('missing gesture definition');
  return definition;
}

describe('gesture run dispatch', () => {
  // Each entry pins both halves of the run projection: which
  // `client.interactions.*` method the kind routes to and how its payload
  // lands on that method's options (`gesture.test.ts` covers the reader and
  // daemon writer, not this client-side projection).
  test.for([
    {
      argv: ['pan', '10', '20', '5', '6', '300'],
      method: 'pan',
      options: { x: 10, y: 20, dx: 5, dy: 6, durationMs: 300 },
    },
    {
      argv: ['fling', 'up', '10', '20', '400'],
      method: 'fling',
      options: { direction: 'up', x: 10, y: 20, distance: 400 },
    },
    { argv: ['swipe', 'left-edge'], method: 'swipeGesture', options: { preset: 'left-edge' } },
    { argv: ['pinch', '2', '30', '40'], method: 'pinch', options: { scale: 2, x: 30, y: 40 } },
    {
      argv: ['rotate', '45', '10', '20'],
      method: 'rotateGesture',
      options: { degrees: 45, x: 10, y: 20 },
    },
    {
      argv: ['transform', '10', '20', '5', '6', '1.5', '45', '250'],
      method: 'transformGesture',
      options: { x: 10, y: 20, dx: 5, dy: 6, scale: 1.5, degrees: 45, durationMs: 250 },
    },
    {
      argv: ['drag', 'id="drag-source"', '@e2~s42', '700', '600', '200'],
      method: 'drag',
      options: {
        source: 'id="drag-source"',
        destination: '@e2~s42',
        sourceHoldMs: 700,
        moveMs: 600,
        destinationHoldMs: 200,
      },
    },
  ])(
    '%argv routes to client.interactions.%method with projected options',
    async ({ argv, method, options }) => {
      const calls: Array<{ method: string; options: unknown }> = [];
      const input = gestureCliReaders.gesture(argv, NO_FLAGS);
      await gestureDefinition().invoke(recordingGestureClient(calls), input);
      expect(calls).toHaveLength(1);
      expect(calls[0]?.method).toBe(method);
      expect(calls[0]?.options).toMatchObject(options);
    },
  );

  test('pinch without an origin still projects the scale', async () => {
    const calls: Array<{ method: string; options: unknown }> = [];
    const input = gestureCliReaders.gesture(['pinch', '2'], NO_FLAGS);
    await gestureDefinition().invoke(recordingGestureClient(calls), input);
    const options = calls[0]?.options as { scale?: number; x?: unknown } | undefined;
    expect(options).toMatchObject({ scale: 2 });
    expect(options?.x).toBeUndefined();
  });
});
