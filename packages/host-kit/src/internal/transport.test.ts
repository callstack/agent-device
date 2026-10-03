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

test('loadNodeHttpRequester selects the protocol module and keeps request mutable', async () => {
  const httpRequester = await loadNodeHttpRequester('http:');
  const httpsRequester = await loadNodeHttpRequester('https:');
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
});

test('readNodeHttpRequestBody returns bytes and preserves the caller error message at the limit', async () => {
  const request = Readable.from([
    Buffer.from('hello '),
    Buffer.from('world'),
  ]) as unknown as IncomingMessage;
  assert.deepEqual(
    await readNodeHttpRequestBody(request, 11, 'body exceeded'),
    Buffer.from('hello world'),
  );

  const oversized = Readable.from([Buffer.from('hello world!')]) as unknown as IncomingMessage;
  await assert.rejects(
    readNodeHttpRequestBody(oversized, 11, 'body exceeded'),
    (error: unknown) => {
      assert.ok(error instanceof AppError);
      assert.equal(error.code, 'INVALID_ARGS');
      assert.equal(error.message, 'body exceeded');
      return true;
    },
  );
});

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
