import { describe, expect, test } from 'vitest';
import type { CliFlags } from '../cli-grammar/flag-types.ts';
import type { CommandInput } from '../cli-grammar/types.ts';
import { gestureCliReaders, gestureDaemonWriters } from './gesture.ts';

const NO_FLAGS = {} as CliFlags;

function readCli(positionals: string[]) {
  return gestureCliReaders.gesture(positionals, NO_FLAGS);
}

function writePositionals(writerKey: keyof typeof gestureDaemonWriters, input: CommandInput) {
  const request = gestureDaemonWriters[writerKey](input);
  expect(request.command).toBe('gesture');
  return request.positionals;
}

function expectInvalidArgs(fn: () => unknown, messageFragment?: string) {
  expect(fn).toThrow(
    expect.objectContaining({
      code: 'INVALID_ARGS',
      ...(messageFragment ? { message: expect.stringContaining(messageFragment) } : {}),
    }),
  );
}

describe('gestureInputFromCli reader', () => {
  test('parses a pan gesture with origin, delta and duration', () => {
    expect(readCli(['pan', '10', '20', '5', '6', '300'])).toMatchObject({
      kind: 'pan',
      origin: { x: 10, y: 20 },
      delta: { x: 5, y: 6 },
      durationMs: 300,
    });
  });

  test('leaves an omitted pan duration undefined', () => {
    expect(readCli(['pan', '10', '20', '5', '6']).durationMs).toBeUndefined();
  });

  test('parses a fling gesture with direction, origin, distance and duration', () => {
    expect(readCli(['fling', 'up', '10', '20', '100', '250'])).toMatchObject({
      kind: 'fling',
      direction: 'up',
      origin: { x: 10, y: 20 },
      distance: 100,
      durationMs: 250,
    });
  });

  test('parses a swipe preset gesture', () => {
    expect(readCli(['swipe', 'left', '400'])).toMatchObject({
      kind: 'swipe',
      preset: 'left',
      durationMs: 400,
    });
  });

  test('parses a pinch gesture with an explicit origin', () => {
    expect(readCli(['pinch', '2', '10', '20'])).toMatchObject({
      kind: 'pinch',
      scale: 2,
      origin: { x: 10, y: 20 },
    });
  });

  test('leaves the pinch origin undefined when coordinates are missing', () => {
    expect(readCli(['pinch', '0.5']).origin).toBeUndefined();
  });

  test('parses a rotate gesture with origin and velocity', () => {
    expect(readCli(['rotate', '90', '10', '20', '5'])).toMatchObject({
      kind: 'rotate',
      degrees: 90,
      origin: { x: 10, y: 20 },
      velocity: 5,
    });
  });

  test('leaves the rotate origin undefined when coordinates are missing', () => {
    expect(readCli(['rotate', '45']).origin).toBeUndefined();
  });

  test('parses a transform gesture with all parameters', () => {
    expect(readCli(['transform', '1', '2', '3', '4', '1.5', '30', '200'])).toMatchObject({
      kind: 'transform',
      origin: { x: 1, y: 2 },
      delta: { x: 3, y: 4 },
      scale: 1.5,
      degrees: 30,
      durationMs: 200,
    });
  });

  test('rejects an unknown gesture subcommand', () => {
    expectInvalidArgs(() => readCli(['twist']), 'gesture requires pan, fling, swipe');
  });
});

describe('gesture daemon writers', () => {
  test('the default gesture writer serializes a pan kind from origin/delta', () => {
    const positionals = writePositionals('gesture', {
      kind: 'pan',
      origin: { x: 10, y: 20 },
      delta: { x: 5, y: 6 },
      durationMs: 300,
    } as CommandInput);
    expect(positionals).toEqual(['pan', '10', '20', '5', '6', '300']);
  });

  test('the default gesture writer omits an absent duration', () => {
    const positionals = writePositionals('gesture', {
      kind: 'pan',
      origin: { x: 1, y: 2 },
      delta: { x: 3, y: 4 },
    } as CommandInput);
    expect(positionals).toEqual(['pan', '1', '2', '3', '4']);
  });

  test('the default gesture writer serializes swipe presets', () => {
    expect(
      writePositionals('gesture', { kind: 'swipe', preset: 'up', durationMs: 400 } as CommandInput),
    ).toEqual(['swipe', 'up', '400']);
  });

  test('the default gesture writer requires a swipe preset', () => {
    expectInvalidArgs(
      () => writePositionals('gesture', { kind: 'swipe' } as CommandInput),
      'gesture swipe requires preset',
    );
  });

  test('the default gesture writer requires a fling direction', () => {
    expectInvalidArgs(
      () =>
        writePositionals('gesture', {
          kind: 'fling',
          origin: { x: 1, y: 2 },
        } as CommandInput),
      'gesture fling requires direction',
    );
  });

  test('the default gesture writer rejects unknown kinds', () => {
    expectInvalidArgs(
      () => writePositionals('gesture', { kind: 'mystery' } as CommandInput),
      'gesture requires pan, fling, swipe',
    );
  });

  test('the default gesture writer serializes a pinch kind from scale and origin', () => {
    expect(
      writePositionals('gesture', {
        kind: 'pinch',
        scale: 2,
        origin: { x: 10, y: 20 },
      } as CommandInput),
    ).toEqual(['pinch', '2', '10', '20']);
  });

  test('the default gesture writer serializes a rotate kind from degrees and origin', () => {
    expect(
      writePositionals('gesture', {
        kind: 'rotate',
        degrees: 90,
        origin: { x: 10, y: 20 },
        velocity: 5,
      } as CommandInput),
    ).toEqual(['rotate', '90', '10', '20', '5']);
  });

  test('the default gesture writer serializes a transform kind from origin/delta/scale/degrees', () => {
    expect(
      writePositionals('gesture', {
        kind: 'transform',
        origin: { x: 1, y: 2 },
        delta: { x: 3, y: 4 },
        scale: 1.5,
        degrees: 30,
        durationMs: 200,
      } as CommandInput),
    ).toEqual(['transform', '1', '2', '3', '4', '1.5', '30', '200']);
  });

  test('the gesture-pan writer serializes flat x/y/dx/dy coordinates', () => {
    expect(
      writePositionals('gesture-pan', {
        x: 10,
        y: 20,
        dx: 5,
        dy: 6,
        durationMs: 300,
      } as CommandInput),
    ).toEqual(['pan', '10', '20', '5', '6', '300']);
  });

  test('the gesture-fling writer defaults distance to 180 when only a duration is given', () => {
    expect(
      writePositionals('gesture-fling', {
        direction: 'down',
        x: 10,
        y: 20,
        durationMs: 250,
      } as CommandInput),
    ).toEqual(['fling', 'down', '10', '20', '180', '250']);
  });

  test('the gesture-fling writer keeps an explicit distance and omits an absent duration', () => {
    expect(
      writePositionals('gesture-fling', {
        direction: 'up',
        x: 10,
        y: 20,
        distance: 120,
      } as CommandInput),
    ).toEqual(['fling', 'up', '10', '20', '120']);
  });

  test('the gesture-pinch writer serializes scale and optional origin', () => {
    expect(writePositionals('gesture-pinch', { scale: 2, x: 10, y: 20 } as CommandInput)).toEqual([
      'pinch',
      '2',
      '10',
      '20',
    ]);
  });

  test('the gesture-rotate writer serializes degrees with a complete center', () => {
    expect(
      writePositionals('gesture-rotate', {
        degrees: 90,
        x: 10,
        y: 20,
        velocity: 5,
      } as CommandInput),
    ).toEqual(['rotate', '90', '10', '20', '5']);
  });

  test('the gesture-rotate writer omits the center when no coordinates are given', () => {
    expect(writePositionals('gesture-rotate', { degrees: 45 } as CommandInput)).toEqual([
      'rotate',
      '45',
    ]);
  });

  test('the gesture-rotate writer rejects a half-specified center', () => {
    expectInvalidArgs(
      () => writePositionals('gesture-rotate', { degrees: 45, x: 10 } as CommandInput),
      'gesture rotate center requires both x and y',
    );
  });

  test('the gesture-transform writer serializes the full parameter list', () => {
    expect(
      writePositionals('gesture-transform', {
        x: 1,
        y: 2,
        dx: 3,
        dy: 4,
        scale: 1.5,
        degrees: 30,
        durationMs: 200,
      } as CommandInput),
    ).toEqual(['transform', '1', '2', '3', '4', '1.5', '30', '200']);
  });
});
