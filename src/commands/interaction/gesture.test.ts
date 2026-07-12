import { describe, expect, test } from 'vitest';
import type { CliFlags } from '../cli-grammar/flag-types.ts';
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

  test('rejects pointerCount on non-pan gestures', () => {
    expect(() =>
      gestureDaemonWriters.gesture({ kind: 'pinch', scale: 2, pointerCount: 2 }),
    ).toThrow(expect.objectContaining({ code: 'INVALID_ARGS' }));
  });
});
