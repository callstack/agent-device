import assert from 'node:assert/strict';
import { Readable, Writable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { test } from 'vitest';
import { createByteLimitStream } from './byte-limit-stream.ts';

test('byte limit rejects before forwarding overflow and reports accepted bytes only', async () => {
  const limitError = new Error('limit exceeded');
  const limiter = createByteLimitStream({
    maxBytes: 5,
    createLimitError: () => limitError,
  });
  const forwarded: Buffer[] = [];
  const sink = new Writable({
    write(chunk: Buffer, _encoding, callback) {
      forwarded.push(Buffer.from(chunk));
      callback();
    },
  });

  await assert.rejects(
    pipeline(Readable.from([Buffer.from('abc'), Buffer.from('defg')]), limiter, sink),
    (error) => error === limitError,
  );
  assert.equal(Buffer.concat(forwarded).toString(), 'abc');
  assert.equal(limiter.bytesSeen, 3);
});

test('byte limit accepts an exact multi-chunk payload', async () => {
  const limiter = createByteLimitStream({
    maxBytes: 5,
    createLimitError: () => new Error('limit exceeded'),
  });
  const forwarded: Buffer[] = [];
  await pipeline(
    Readable.from([Buffer.from('ab'), Buffer.from('cde')]),
    limiter,
    new Writable({
      write(chunk: Buffer, _encoding, callback) {
        forwarded.push(Buffer.from(chunk));
        callback();
      },
    }),
  );

  assert.equal(Buffer.concat(forwarded).toString(), 'abcde');
  assert.equal(limiter.bytesSeen, 5);
});

test('byte limit rejects invalid limits before constructing a stream', () => {
  for (const maxBytes of [-1, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1, 1.5]) {
    assert.throws(
      () =>
        createByteLimitStream({ maxBytes, createLimitError: () => new Error('limit exceeded') }),
      /non-negative safe integer/,
    );
  }
});
