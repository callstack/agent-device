import { describe, expect, test } from 'vitest';
import type { CliFlags } from '@agent-device/contracts/command';
import { readInputFromCli, runCommand } from '@agent-device/command-surface';
import { createAgentDeviceClient } from '../index.ts';
import { createClientTransport } from '@agent-device/test-kit';

const NO_FLAGS = {} as CliFlags;

describe('gesture command transport', () => {
  test.for([
    {
      argv: ['pan', '10', '20', '5', '6', '300'],
      input: { kind: 'pan', origin: { x: 10, y: 20 }, delta: { x: 5, y: 6 }, durationMs: 300 },
    },
    {
      argv: ['fling', 'up', '10', '20', '400'],
      input: { kind: 'fling', direction: 'up', origin: { x: 10, y: 20 }, distance: 400 },
    },
    { argv: ['swipe', 'left-edge'], input: { kind: 'swipe', preset: 'left-edge' } },
    {
      argv: ['pinch', '2', '30', '40'],
      input: { kind: 'pinch', scale: 2, origin: { x: 30, y: 40 } },
    },
    { argv: ['pinch', '2'], input: { kind: 'pinch', scale: 2 } },
    {
      argv: ['rotate', '45', '10', '20'],
      input: { kind: 'rotate', degrees: 45, origin: { x: 10, y: 20 } },
    },
    {
      argv: ['transform', '10', '20', '5', '6', '1.5', '45', '250'],
      input: {
        kind: 'transform',
        origin: { x: 10, y: 20 },
        delta: { x: 5, y: 6 },
        scale: 1.5,
        degrees: 45,
        durationMs: 250,
      },
    },
    {
      argv: ['drag', 'id="drag-source"', '@e2~s42', '700', '600', '200'],
      input: {
        kind: 'drag',
        source: 'id="drag-source"',
        destination: '@e2~s42',
        sourceHoldMs: 700,
        moveMs: 600,
        destinationHoldMs: 200,
      },
    },
  ])('$argv sends structured input through the client transport', async ({ argv, input }) => {
    const setup = createClientTransport(() => ({
      ok: true,
      data: { message: 'Performed gesture' },
    }));
    const client = createAgentDeviceClient(setup.config, { transport: setup.transport });
    const parsed = readInputFromCli('gesture', argv, NO_FLAGS);
    const result = await runCommand(client, 'gesture', {
      ...parsed,
      session: 'gesture-test',
      deviceTarget: 'mobile',
      udid: 'gesture-device',
    });
    expect(result).toEqual({ message: 'Performed gesture' });
    expect(setup.calls).toHaveLength(1);
    expect(setup.calls[0]).toMatchObject({
      command: 'gesture',
      positionals: [],
      session: 'gesture-test',
      flags: { target: 'mobile', udid: 'gesture-device' },
    });
    expect(setup.calls[0]?.input).toEqual({
      ...input,
      session: 'gesture-test',
      deviceTarget: 'mobile',
      udid: 'gesture-device',
    });
  });
});
