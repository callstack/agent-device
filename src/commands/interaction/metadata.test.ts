import { expect, test } from 'vitest';
import { AppError } from '@agent-device/kernel/errors';
import { commandAcceptsReadinessBudget } from '@agent-device/command-registry/registry';
import { findCommandMetadata, listCommandMetadata } from '../command-metadata.ts';
import { interactionCommandMetadata } from './metadata.ts';

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

const SELECTOR_TARGET = { kind: 'selector', selector: 'label=Continue' };

test('a command advertises readinessTimeoutMs exactly when its descriptor declares the budget', () => {
  for (const metadata of listCommandMetadata()) {
    const properties = metadata.inputSchema.properties ?? {};
    expect('readinessTimeoutMs' in properties, metadata.name).toBe(
      commandAcceptsReadinessBudget(metadata.name),
    );
  }
});

test('press reads readinessTimeoutMs', () => {
  const input = findCommandMetadata('press').readInput({
    target: SELECTOR_TARGET,
    readinessTimeoutMs: 2_000,
  }) as { readinessTimeoutMs?: number };
  expect(input.readinessTimeoutMs).toBe(2_000);
});

test('fill refuses readinessTimeoutMs with an input error, and reads without it', () => {
  const fill = findCommandMetadata('fill');
  expect(() => fill.readInput({ target: SELECTOR_TARGET, text: 'hi' })).not.toThrow();
  let refusal: unknown;
  try {
    fill.readInput({ target: SELECTOR_TARGET, text: 'hi', readinessTimeoutMs: 2_000 });
  } catch (error) {
    refusal = error;
  }
  expect(refusal instanceof AppError && refusal.code).toBe('INVALID_ARGS');
});
