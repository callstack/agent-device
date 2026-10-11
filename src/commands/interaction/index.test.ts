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
  test.for([
    { argv: ['pan', '10', '20', '5', '6', '300'], method: 'pan' },
    { argv: ['fling', 'up', '10', '20', '400'], method: 'fling' },
    { argv: ['swipe', 'left-edge'], method: 'swipeGesture' },
    { argv: ['pinch', '2', '30', '40'], method: 'pinch' },
    { argv: ['rotate', '45'], method: 'rotateGesture' },
    { argv: ['transform', '10', '20', '5', '6', '1.5', '45', '250'], method: 'transformGesture' },
    { argv: ['drag', 'id="drag-source"', '@e2~s42', '700', '600', '200'], method: 'drag' },
  ])('%argv routes to client.interactions.%method', async ({ argv, method }) => {
    const calls: Array<{ method: string; options: unknown }> = [];
    const input = gestureCliReaders.gesture(argv, NO_FLAGS);
    await gestureDefinition().invoke(recordingGestureClient(calls), input);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.method).toBe(method);
  });

  test('pan projects origin/delta and the timed movement onto client options', async () => {
    const calls: Array<{ method: string; options: unknown }> = [];
    const input = gestureCliReaders.gesture(['pan', '10', '20', '5', '6', '300'], NO_FLAGS);
    await gestureDefinition().invoke(recordingGestureClient(calls), input);
    expect(calls[0]?.options).toMatchObject({ x: 10, y: 20, dx: 5, dy: 6, durationMs: 300 });
  });

  test('drag projects selectors and hold durations onto client options', async () => {
    const calls: Array<{ method: string; options: unknown }> = [];
    const input = gestureCliReaders.gesture(
      ['drag', 'id="drag-source"', '@e2~s42', '700', '600', '200'],
      NO_FLAGS,
    );
    await gestureDefinition().invoke(recordingGestureClient(calls), input);
    expect(calls[0]?.options).toMatchObject({
      source: 'id="drag-source"',
      destination: '@e2~s42',
      sourceHoldMs: 700,
      moveMs: 600,
      destinationHoldMs: 200,
    });
  });

  test('pinch without an origin still projects the scale', async () => {
    const calls: Array<{ method: string; options: unknown }> = [];
    const input = gestureCliReaders.gesture(['pinch', '2'], NO_FLAGS);
    await gestureDefinition().invoke(recordingGestureClient(calls), input);
    const options = calls[0]?.options as { scale?: number; x?: unknown } | undefined;
    expect(options).toMatchObject({ scale: 2 });
    expect(options?.x).toBeUndefined();
  });
});
