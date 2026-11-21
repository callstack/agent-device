import { expect, test } from 'vitest';
import { AppError } from '@agent-device/kernel/errors';
import { interactionCommandMetadata } from './metadata.ts';
import { interactionDaemonWriters } from './interactions.ts';

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
    ref: '@e57',
    text: '',
  }) as { text: unknown };

  expect(input.text).toBe('');
});

test('fill still refuses a missing text', () => {
  if (!fillMetadata) throw new Error('expected fill metadata');
  try {
    fillMetadata.readInput({ ref: '@e57' });
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
    fillMetadata.readInput({ ref: '@e57', text: 42 });
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

    expect(metadata.inputSchema.properties?.postGestureStabilization?.type).toBe('boolean');
    expect(metadata.inputAudience.postGestureStabilization?.kind).toBe('operator');
    expect(
      metadata.readInput({ ...EXAMPLE_INPUT[name], postGestureStabilization: false }),
    ).toMatchObject({
      postGestureStabilization: false,
    });
  },
);

test('gesture keeps the stabilization opt-out for a swipe and drops it for any other kind', () => {
  const gesture = interactionCommandMetadata.find((entry) => entry.name === 'gesture');
  if (!gesture) throw new Error('expected gesture metadata');

  expect(gesture.inputAudience.postGestureStabilization?.kind).toBe('operator');
  expect(
    gesture.readInput({ kind: 'swipe', preset: 'left', postGestureStabilization: false }),
  ).toMatchObject({ kind: 'swipe', postGestureStabilization: false });
  expect(
    gesture.readInput({
      kind: 'pan',
      origin: { x: 1, y: 1 },
      delta: { x: 1, y: 9 },
      postGestureStabilization: false,
    }),
  ).not.toHaveProperty('postGestureStabilization');
});

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

// The target is optional on `type` and accepts a snapshot ref only: the schema exposes ref and
// label beside the required text, so a targetless `type "text"` keeps validating exactly as
// before, while a structured selector or point is refused where the caller can see it instead of
// re-splitting into text (#4870 review).
test('type declares the optional snapshot-ref target beside the required text', () => {
  const typeMetadata = interactionCommandMetadata.find((metadata) => metadata.name === 'type');
  if (!typeMetadata) throw new Error('expected type metadata');

  expect(typeMetadata.inputSchema.properties?.ref).toBeDefined();
  expect(typeMetadata.inputSchema.properties?.label).toBeDefined();
  expect(typeMetadata.inputSchema.properties?.selector).toBeUndefined();
  expect(typeMetadata.inputSchema.properties?.x).toBeUndefined();
  expect(typeMetadata.inputSchema.properties?.y).toBeUndefined();
  expect(typeMetadata.inputSchema.required).toEqual(['text']);
  expect(typeMetadata.readInput({ ref: '@e12', text: 'more' })).toMatchObject({
    ref: '@e12',
    text: 'more',
  });
  expect(typeMetadata.readInput({ text: 'more' })).not.toHaveProperty('ref');
});

test('type gates the ref at the shared daemon projection', () => {
  const typeMetadata = interactionCommandMetadata.find((metadata) => metadata.name === 'type');
  if (!typeMetadata) throw new Error('expected type metadata');

  // The reader passes the field through: the gate lives once at the shared projection
  // (typePositionals), so the typed Node client route refuses the same values (#4870 review).
  expect(typeMetadata.readInput({ ref: 'Email', text: 'more' })).toMatchObject({
    ref: 'Email',
    text: 'more',
  });
  // A bare minted id names the same target the snapshot minted: it normalizes to the
  // @-prefixed token the daemon decodes.
  expect(interactionDaemonWriters.type({ ref: 'e12', text: 'more' }).positionals).toEqual([
    '@e12',
    'more',
  ]);
  // A lookalike word is not a ref: the projection refuses it before any dispatch.
  expect(() => interactionDaemonWriters.type({ ref: 'Email', text: 'more' })).toThrow(AppError);
});

test('type keeps a ref label out of the projected text positionals', () => {
  const typeMetadata = interactionCommandMetadata.find((metadata) => metadata.name === 'type');
  if (!typeMetadata) throw new Error('expected type metadata');

  const input = typeMetadata.readInput({ ref: '@e12', label: 'Email', text: 'more' }) as {
    ref?: string;
    label?: string;
    text: string;
  };
  expect(input).toMatchObject({ ref: '@e12', label: 'Email', text: 'more' });
  // The daemon projection owns the vocabulary: the label names the ref for humans and must
  // never become text the command types (#4870 review).
  expect(interactionDaemonWriters.type(input).positionals).toEqual(['@e12', 'more']);
});

test('type refuses a selector or point target and a label without a ref', () => {
  const typeMetadata = interactionCommandMetadata.find((metadata) => metadata.name === 'type');
  if (!typeMetadata) throw new Error('expected type metadata');

  for (const input of [
    { selector: 'id="submit"', text: 'more' },
    { x: 100, y: 200, text: 'more' },
    { x: 100, text: 'more' },
    // Two targets: the ref plus any other target form is refused the same way.
    { ref: '@e12', selector: 'id="submit"', text: 'more' },
    { ref: '@e12', x: 100, y: 200, text: 'more' },
    { label: 'Email', text: 'more' },
  ] as const) {
    try {
      typeMetadata.readInput({ ...input });
      expect.unreachable(`type should refuse ${JSON.stringify(input)}`);
    } catch (error) {
      expect(error, JSON.stringify(input)).toBeInstanceOf(AppError);
      expect((error as AppError).code, JSON.stringify(input)).toBe('INVALID_ARGS');
    }
  }
});
