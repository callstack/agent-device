import assert from 'node:assert/strict';
import { test } from 'vitest';
import { parseUploadContentLength, parseUploadContentRange } from '../resumable-upload-range.ts';

test('content ranges are bounded by the declared upload size', () => {
  assert.deepEqual(parseUploadContentRange('bytes 2-4/5', 5), {
    start: 2,
    end: 4,
    size: 5,
    span: 3,
  });
  for (const value of ['bytes 0-5/5', 'bytes 5-5/5', 'bytes 0-0/0']) {
    assert.throws(() => parseUploadContentRange(value, Number(value.split('/')[1])));
  }
});

test('content range and length numbers use decimal safe-integer grammar', () => {
  for (const value of ['+1', '1e3', '0x10', '1.5', '-1', '9007199254740992']) {
    assert.throws(() => parseUploadContentLength(value), value);
  }
  assert.equal(parseUploadContentLength('0'), 0);
  assert.equal(parseUploadContentLength('123'), 123);
  assert.equal(parseUploadContentLength(undefined), undefined);
});
