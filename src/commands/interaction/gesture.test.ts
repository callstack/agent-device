import { describe, expect, test } from 'vitest';
import type { CliFlags } from '@agent-device/contracts/command';
import { gestureCliReaders, gestureDaemonWriters } from './gesture.ts';

const NO_FLAGS = {} as CliFlags;

describe('gesture command projection', () => {
  test('parses one-finger pan by default and explicit two-finger pan', () => {
    expect(gestureCliReaders.gesture(['pan', '10', '20', '5', '6', '300'], NO_FLAGS)).toMatchObject(
      {
        kind: 'pan',
        origin: { x: 10, y: 20 },
        delta: { x: 5, y: 6 },
        durationMs: 300,
      },
    );
    expect(
      gestureCliReaders.gesture(['pan', '10', '20', '5', '6'], {
        ...NO_FLAGS,
        pointerCount: 2,
      }),
    ).toMatchObject({
      kind: 'pan',
      pointerCount: 2,
    });
  });

  test('writes only typed daemon input', () => {
    const request = gestureDaemonWriters.gesture({
      kind: 'pan',
      origin: { x: 10, y: 20 },
      delta: { x: 5, y: 6 },
      pointerCount: 2,
      durationMs: 300,
    });
    expect(request.command).toBe('gesture');
    expect(request.positionals).toEqual([]);
    expect(request.input).toEqual({
      kind: 'pan',
      origin: { x: 10, y: 20 },
      delta: { x: 5, y: 6 },
      pointerCount: 2,
      durationMs: 300,
    });
  });

  test('parses and writes selector/ref drag input without positional reinterpretation', () => {
    const input = gestureCliReaders.gesture(
      ['drag', 'id="drag-source"', '@e2~s42', '700', '600', '200'],
      NO_FLAGS,
    );
    expect(input).toEqual({
      kind: 'drag',
      source: 'id="drag-source"',
      destination: '@e2~s42',
      sourceHoldMs: 700,
      moveMs: 600,
      destinationHoldMs: 200,
    });
    expect(gestureDaemonWriters.gesture(input).input).toEqual(input);
  });

  test('parses a tap with its series flags and writes it as typed daemon input', () => {
    const input = gestureCliReaders.gesture(['tap', '80', '300', '200', '450'], {
      ...NO_FLAGS,
      holdMs: 40,
      count: 3,
      pauseMs: 100,
    });
    expect(input).toEqual({
      kind: 'tap',
      points: [
        { x: 80, y: 300 },
        { x: 200, y: 450 },
      ],
      holdMs: 40,
      count: 3,
      pauseMs: 100,
    });
    expect(gestureDaemonWriters.gesture(input).input).toEqual(input);
  });

  test('rejects pointerCount on non-pan gestures', () => {
    expect(() =>
      gestureDaemonWriters.gesture({ kind: 'pinch', scale: 2, pointerCount: 2 }),
    ).toThrow(expect.objectContaining({ code: 'INVALID_ARGS' }));
  });
});
