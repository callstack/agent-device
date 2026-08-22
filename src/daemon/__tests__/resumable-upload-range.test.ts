import assert from 'node:assert/strict';
import { test } from 'vitest';
import { assertThrowsAppError } from '../../__tests__/test-utils/app-error.ts';
import { parseUploadContentLength, parseUploadContentRange } from '../resumable-upload-range.ts';

test('content ranges are bounded by the declared upload size', () => {
  assert.deepEqual(parseUploadContentRange('bytes 2-4/5', 5), {
    start: 2,
    end: 4,
    size: 5,
    span: 3,
  });
  for (const value of ['bytes 0-5/5', 'bytes 5-5/5', 'bytes 0-0/0']) {
    assertThrowsAppError(() => parseUploadContentRange(value, Number(value.split('/')[1])), {
      code: 'INVALID_ARGS',
      message: /Invalid content-range header/,
    });
  }
});

test('content range and length numbers use decimal safe-integer grammar', () => {
  for (const value of ['+1', '1e3', '0x10', '1.5', '-1', '9007199254740992']) {
    // A string second argument to node:assert's throws helper is its failure message,
    // never an error matcher (a documented Node.js gotcha) — this loop was silently
    // accepting any failure. Assert the real code instead.
    assertThrowsAppError(() => parseUploadContentLength(value), {
      code: 'INVALID_ARGS',
      message: /Invalid content-length header/,
    });
  }
  assert.equal(parseUploadContentLength('0'), 0);
  assert.equal(parseUploadContentLength('123'), 123);
  assert.equal(parseUploadContentLength(undefined), undefined);
});
