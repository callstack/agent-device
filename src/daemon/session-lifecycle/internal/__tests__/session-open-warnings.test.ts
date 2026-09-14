import assert from 'node:assert/strict';
import { test } from 'vitest';
import { appendResponseWarning, readResponseWarnings } from '../session-open-warnings.ts';

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

test('reading warnings ignores anything that is not a note', () => {
  assert.deepEqual(readResponseWarnings({ warnings: ['a note', 42, { nested: true }, null] }), [
    'a note',
  ]);
  assert.deepEqual(readResponseWarnings({}), []);
  assert.deepEqual(readResponseWarnings(undefined), []);
});
