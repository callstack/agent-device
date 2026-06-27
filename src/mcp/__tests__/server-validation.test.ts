import assert from 'node:assert/strict';
import { test } from 'vitest';
import { createMcpPayloadQueue, handleMcpPayload } from '../server.ts';

type JsonRpcResponse = {
  jsonrpc: '2.0';
  id: string | number | null;
  result?: unknown;
  error?: { code: number; message: string };
};

test('boundary parse accepts a valid request and routes it as before', async () => {
  const response = (await handleMcpPayload({
    jsonrpc: '2.0',
    id: 7,
    method: 'ping',
  })) as JsonRpcResponse;

  assert.deepEqual(response, { jsonrpc: '2.0', id: 7, result: {} });
});

test('boundary parse accepts a notification (no id) and produces no response', async () => {
  const response = await handleMcpPayload({
    jsonrpc: '2.0',
    method: 'notifications/initialized',
  });

  assert.equal(response, null);
});

test('boundary parse accepts a batch, preserving request order and skipping notifications', async () => {
  const response = (await handleMcpPayload([
    { jsonrpc: '2.0', id: 'first', method: 'ping' },
    { jsonrpc: '2.0', method: 'notifications/initialized' },
    { jsonrpc: '2.0', id: 'second', method: 'ping' },
  ])) as JsonRpcResponse[];

  assert.deepEqual(
    response.map((entry) => entry.id),
    ['first', 'second'],
  );
  for (const entry of response) {
    assert.deepEqual(entry.result, {});
  }
});

test('boundary parse keeps a request with an explicit null id', async () => {
  const response = (await handleMcpPayload({
    jsonrpc: '2.0',
    id: null,
    method: 'ping',
  })) as JsonRpcResponse;

  assert.deepEqual(response, { jsonrpc: '2.0', id: null, result: {} });
});

test('malformed message with a wrong-typed method is rejected with -32600, preserving id', async () => {
  const response = (await handleMcpPayload({
    jsonrpc: '2.0',
    id: 42,
    method: 123,
  })) as JsonRpcResponse;

  assert.equal(response.jsonrpc, '2.0');
  assert.equal(response.id, 42);
  assert.equal(response.error?.code, -32600);
  assert.equal(response.error?.message, 'Invalid JSON-RPC request.');
});

test('a non-object payload is rejected with -32600 and a null id instead of crashing', async () => {
  const response = (await handleMcpPayload('not-an-object')) as JsonRpcResponse;

  assert.equal(response.id, null);
  assert.equal(response.error?.code, -32600);
});

test('a batch rejects only its malformed element while routing the valid ones', async () => {
  const response = (await handleMcpPayload([
    { jsonrpc: '2.0', id: 'ok', method: 'ping' },
    { jsonrpc: '2.0', id: 'bad', method: 999 },
  ])) as JsonRpcResponse[];

  assert.equal(response.length, 2);
  assert.deepEqual(response[0]?.result, {});
  assert.equal(response[1]?.id, 'bad');
  assert.equal(response[1]?.error?.code, -32600);
});

test('a malformed payload pushed through the queue is written as a -32600 error response', async () => {
  const writes: JsonRpcResponse[] = [];
  const queue = createMcpPayloadQueue({
    write: (message) => {
      writes.push(message as JsonRpcResponse);
    },
  });

  queue.push({ jsonrpc: '2.0', id: 5, method: { not: 'a string' } });
  await queue.idle();

  assert.equal(writes.length, 1);
  assert.equal(writes[0]?.id, 5);
  assert.equal(writes[0]?.error?.code, -32600);
});
