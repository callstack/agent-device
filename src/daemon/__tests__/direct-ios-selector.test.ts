import { test } from 'vitest';
import assert from 'node:assert/strict';
import { AppError } from '../../kernel/errors.ts';
import { isDirectIosSelectorFallbackError } from '../direct-ios-selector.ts';

test('runner ELEMENT_OFFSCREEN always falls back to tree-based resolution', () => {
  const error = new AppError('ELEMENT_OFFSCREEN', 'element resolved off-screen at (-161, 265)');
  assert.equal(isDirectIosSelectorFallbackError(error), true);
  assert.equal(isDirectIosSelectorFallbackError(error, { allowElementNotFound: false }), true);
});

test('runner ELEMENT_NOT_FOUND falls back only when the caller allows it', () => {
  const error = new AppError('ELEMENT_NOT_FOUND', 'element not found');
  assert.equal(isDirectIosSelectorFallbackError(error), false);
  assert.equal(isDirectIosSelectorFallbackError(error, { allowElementNotFound: true }), true);
});

test('transport-level COMMAND_FAILED errors fall back, semantic ones do not', () => {
  assert.equal(
    isDirectIosSelectorFallbackError(new AppError('COMMAND_FAILED', 'fetch failed')),
    true,
  );
  assert.equal(
    isDirectIosSelectorFallbackError(
      new AppError('COMMAND_FAILED', 'Runner command deadline exceeded: timed out'),
    ),
    true,
  );
  assert.equal(
    isDirectIosSelectorFallbackError(new AppError('COMMAND_FAILED', 'element covered by overlay')),
    false,
  );
  assert.equal(
    isDirectIosSelectorFallbackError(new AppError('AMBIGUOUS_MATCH', 'multiple')),
    false,
  );
});
