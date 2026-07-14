import { test } from 'vitest';
import assert from 'node:assert/strict';
import { AppError } from '../../kernel/errors.ts';
import { isDirectIosSelectorFallbackError } from '../direct-ios-selector.ts';

test('runner ELEMENT_OFFSCREEN delegates normally but stays typed for Maestro replay', () => {
  const error = new AppError('ELEMENT_OFFSCREEN', 'element resolved off-screen at (-161, 265)');
  assert.equal(isDirectIosSelectorFallbackError(error), true);
  assert.equal(isDirectIosSelectorFallbackError(error, { allowElementNotFound: false }), true);
  assert.equal(isDirectIosSelectorFallbackError(error, { delegateSemanticFailures: true }), true);
  assert.equal(isDirectIosSelectorFallbackError(error, { delegateSemanticFailures: false }), false);
});

test('runner ELEMENT_NOT_FOUND falls back for query callers that allow it', () => {
  const error = new AppError('ELEMENT_NOT_FOUND', 'element not found');
  assert.equal(isDirectIosSelectorFallbackError(error), false);
  assert.equal(isDirectIosSelectorFallbackError(error, { allowElementNotFound: true }), true);
});

test('semantic failures delegate to the runtime path for interaction dispatches (ADR 0011)', () => {
  const notFound = new AppError('ELEMENT_NOT_FOUND', 'element not found');
  const ambiguous = new AppError('AMBIGUOUS_MATCH', 'multiple');
  assert.equal(
    isDirectIosSelectorFallbackError(notFound, { delegateSemanticFailures: true }),
    true,
  );
  assert.equal(
    isDirectIosSelectorFallbackError(ambiguous, { delegateSemanticFailures: true }),
    true,
  );
});

test('maestro replay dispatches preserve the runner semantic error shapes (no fallback)', () => {
  const notFound = new AppError('ELEMENT_NOT_FOUND', 'element not found');
  const ambiguous = new AppError('AMBIGUOUS_MATCH', 'multiple');
  assert.equal(
    isDirectIosSelectorFallbackError(notFound, { delegateSemanticFailures: false }),
    false,
  );
  assert.equal(
    isDirectIosSelectorFallbackError(ambiguous, { delegateSemanticFailures: false }),
    false,
  );
});

test('AMBIGUOUS_MATCH does not fall back on the query path (allowElementNotFound callers)', () => {
  const ambiguous = new AppError('AMBIGUOUS_MATCH', 'multiple');
  assert.equal(isDirectIosSelectorFallbackError(ambiguous), false);
  assert.equal(isDirectIosSelectorFallbackError(ambiguous, { allowElementNotFound: true }), false);
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
});
