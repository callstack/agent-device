import assert from 'node:assert/strict';
import { test } from 'vitest';
import { appendResponseWarning } from '../session-open-warnings.ts';

test('a producer adds its note without dropping the notes already on the response', () => {
  const responseData: Record<string, unknown> = { warnings: ['the session is already open'] };

  appendResponseWarning(responseData, 'the device was taken over');

  assert.deepEqual(responseData.warnings, [
    'the session is already open',
    'the device was taken over',
  ]);
});

test('a response that carries no warnings yet starts from an empty list', () => {
  const responseData: Record<string, unknown> = {};

  appendResponseWarning(responseData, 'the device was taken over');

  assert.deepEqual(responseData.warnings, ['the device was taken over']);
});

test('accumulating onto non-note entries keeps only the notes and the new one', () => {
  const responseData: Record<string, unknown> = {
    warnings: ['a note', 42, { nested: true }, null],
  };

  appendResponseWarning(responseData, 'the device was taken over');

  assert.deepEqual(responseData.warnings, ['a note', 'the device was taken over']);
});
