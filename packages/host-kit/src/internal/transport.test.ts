import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import http from 'node:http';
import type { IncomingMessage } from 'node:http';
import https from 'node:https';
import { Readable } from 'node:stream';
import { test } from 'vitest';
import { AppError } from '@agent-device/kernel/errors';
import {
  consumeTextLines,
  loadNodeHttpRequester,
  readNodeHttpRequestBody,
  readNodeHttpResponseBody,
  timingSafeStringEqual,
} from '../transport.ts';

test('consumeTextLines trims complete lines and retains a partial line', () => {
  const first = consumeTextLines('', ' first\n\nsecond');
  assert.deepEqual(first.lines, ['first']);
  assert.equal(first.buffer, 'second');

  const second = consumeTextLines(first.buffer, '-part\n third \n');
  assert.deepEqual(second.lines, ['second-part', 'third']);
  assert.equal(second.buffer, '');
});

test.each(['http://10.0.0.7:4310', 'http://[fd00::1]:4310'])(
  'loadNodeHttpRequester refuses a credential to %s',
  async (url) => {
    await assert.rejects(
      () => loadNodeHttpRequester(new URL(url), { subject: 'Test URL' }),
      (error: unknown) =>
        error instanceof AppError && error.details?.reason === 'insecure_credential_transport',
    );
  },
);

test('loadNodeHttpRequester selects the protocol module and keeps request mutable', async () => {
  const httpRequester = await loadNodeHttpRequester(new URL('http://127.0.0.1'));
  const httpsRequester = await loadNodeHttpRequester(new URL('https://remote.example'));
  assert.equal(httpRequester, http);
  assert.equal(httpsRequester, https);

  const originalRequest = httpRequester.request;
  const stub = (() => {}) as unknown as typeof originalRequest;
  const mutableRequester = httpRequester as { request: typeof originalRequest };
  try {
    mutableRequester.request = stub;
    assert.equal(httpRequester.request, stub);
  } finally {
    mutableRequester.request = originalRequest;
  }
});

test('readNodeHttpResponseBody decodes the complete response stream', async () => {
  const response = Readable.from(['hello', Buffer.from(' world')]) as unknown as IncomingMessage;
  assert.equal(await readNodeHttpResponseBody(response), 'hello world');
  const observed: string[] = [];
  const progressing = Readable.from(['hello', Buffer.from(' world')]) as unknown as IncomingMessage;
  assert.equal(
    await readNodeHttpResponseBody(progressing, (chunk) => observed.push(chunk)),
    'hello world',
  );
  assert.deepEqual(observed, ['hello', ' world']);
});

test('readNodeHttpRequestBody returns bytes and preserves the caller error message at the limit', async () => {
  const request = bodyRequest([Buffer.from('hello '), Buffer.alloc(0), Buffer.from('world')]);
  const accepted: number[] = [];
  const onAcceptedBytes = (bytes: number) => accepted.push(bytes);
  assert.deepEqual(
    await readNodeHttpRequestBody(request, 11, 'body exceeded', onAcceptedBytes),
    Buffer.from('hello world'),
  );
  assert.deepEqual(accepted, [6, 5]);

  const oversized = bodyRequest([Buffer.from('hello '), Buffer.from('world!')]);
  accepted.length = 0;
  await assert.rejects(
    readNodeHttpRequestBody(oversized, 11, 'body exceeded', onAcceptedBytes),
    (error: unknown) => {
      assert.ok(error instanceof AppError);
      assert.equal(error.code, 'INVALID_ARGS');
      assert.equal(error.message, 'body exceeded');
      return true;
    },
  );
  assert.deepEqual(accepted, [6]);
  // The refusal leaves the request intact for its response owner to end.
  assert.equal((oversized as unknown as Readable).destroyed, false);
});

test('readNodeHttpRequestBody refuses a declared length over the bound before reading', async () => {
  const declared = bodyRequest([Buffer.from('ok')], { 'content-length': '12' });
  await assert.rejects(
    readNodeHttpRequestBody(declared, 11, 'body exceeded'),
    (error: unknown) => error instanceof AppError && error.message === 'body exceeded',
  );
  assert.equal(declared.readableEnded, false, 'no byte was read');
});

function bodyRequest(chunks: Buffer[], headers: Record<string, string> = {}): IncomingMessage {
  return Object.assign(Readable.from(chunks), { headers }) as unknown as IncomingMessage;
}

test('timingSafeStringEqual handles equal, unequal, and unequal-length secrets', () => {
  assert.equal(timingSafeStringEqual('secret', 'secret'), true);
  assert.equal(timingSafeStringEqual('secret', 'secreT'), false);
  assert.equal(timingSafeStringEqual('secret', 'secret-longer'), false);
  assert.equal(timingSafeStringEqual('', ''), true);
});

test('readNodeHttpResponseBody propagates response errors', async () => {
  const response = new EventEmitter() as unknown as IncomingMessage;
  response.setEncoding = (_encoding: BufferEncoding) => response;
  const promise = readNodeHttpResponseBody(response);
  const error = new Error('response failed');
  response.emit('error', error);
  await assert.rejects(promise, error);
});
