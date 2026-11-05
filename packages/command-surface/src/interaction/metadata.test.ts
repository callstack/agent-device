import { expect, test } from 'vitest';
import { AppError } from '@agent-device/kernel/errors';
import { interactionCommandMetadata } from './metadata.ts';

const EXAMPLE_INPUT = {
  scroll: { direction: 'down' },
  swipe: { from: { x: 1, y: 1 }, to: { x: 1, y: 9 } },
} as const;

// `fill <target> ""` is the clear-field primitive (#2063): before it existed, emptying an input
// was not expressible at all — `fill` refused the empty string and `keyboard` had no delete verb.
// The empty string therefore has to survive input validation, while a MISSING text argument must
// still be refused: otherwise a forgotten argument silently erases the field.
const fillMetadata = interactionCommandMetadata.find((metadata) => metadata.name === 'fill');

test('fill accepts an empty text as the clear request', () => {
  if (!fillMetadata) throw new Error('expected fill metadata');
  const input = fillMetadata.readInput({
    target: { kind: 'ref', ref: '@e57' },
    text: '',
  }) as { text: unknown };

  expect(input.text).toBe('');
});

test('fill still refuses a missing text', () => {
  if (!fillMetadata) throw new Error('expected fill metadata');
  try {
    fillMetadata.readInput({ target: { kind: 'ref', ref: '@e57' } });
    expect.unreachable('fill should refuse input without text');
  } catch (error) {
    expect(error).toBeInstanceOf(AppError);
    expect((error as AppError).code).toBe('INVALID_ARGS');
    expect((error as AppError).message).toMatch(/text to be set/);
  }
});

test('fill refuses a non-string text', () => {
  if (!fillMetadata) throw new Error('expected fill metadata');
  try {
    fillMetadata.readInput({ target: { kind: 'ref', ref: '@e57' }, text: 42 });
    expect.unreachable('fill should refuse a non-string text');
  } catch (error) {
    expect((error as AppError).code).toBe('INVALID_ARGS');
  }
});

// The audience narrows the model-facing tool schemas only: the CLI and the Node client read the
// same schema, and that is where a caller that polls the screen states the opt-out.
test.for(['scroll', 'swipe'] as const)(
  '%s offers the stabilization opt-out to the Node client and declares it operator-owned',
  (name) => {
    const metadata = interactionCommandMetadata.find((entry) => entry.name === name);
    if (!metadata) throw new Error(`expected ${name} metadata`);

    expect(metadata.inputSchema.properties?.noPostGestureStabilization?.type).toBe('boolean');
    expect(metadata.inputAudience.noPostGestureStabilization?.kind).toBe('operator');
    expect(
      metadata.readInput({ ...EXAMPLE_INPUT[name], noPostGestureStabilization: true }),
    ).toMatchObject({
      noPostGestureStabilization: true,
    });
  },
);

test('type keeps refusing an empty text: appending nothing is not a clear', () => {
  const typeMetadata = interactionCommandMetadata.find((metadata) => metadata.name === 'type');
  if (!typeMetadata) throw new Error('expected type metadata');
  try {
    typeMetadata.readInput({ text: '' });
    expect.unreachable('type should refuse an empty text');
  } catch (error) {
    expect((error as AppError).code).toBe('INVALID_ARGS');
  }
});
