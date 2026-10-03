import assert from 'node:assert/strict';
import { describe, test } from 'vitest';
import { readCommandMessage } from './success-text.ts';

describe('readCommandMessage', () => {
  test('an empty message is absent, not an empty success line', () => {
    assert.equal(readCommandMessage({ message: '' }), null);
    assert.equal(readCommandMessage({ message: 42 }), null);
    assert.equal(readCommandMessage(undefined), null);
    assert.equal(readCommandMessage({ message: 'Replayed 7 steps' }), 'Replayed 7 steps');
  });
});
