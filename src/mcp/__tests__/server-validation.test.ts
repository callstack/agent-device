import assert from 'node:assert/strict';
import { setImmediate } from 'node:timers/promises';
import { test } from 'vitest';
import { createMcpStdioSession, handleMcpPayload } from '../server.ts';

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

test('a malformed payload received on stdio is written as a -32600 error response', async () => {
  const writes: JsonRpcResponse[] = [];
  const session = createMcpStdioSession({
    write: (message) => {
      writes.push(message as JsonRpcResponse);
    },
  });

  session.receive(line({ jsonrpc: '2.0', id: 5, method: { not: 'a string' } }));
  await session.end();

  assert.equal(writes.length, 1);
  assert.equal(writes[0]?.id, 5);
  assert.equal(writes[0]?.error?.code, -32600);
});

test('a blank line does not hold back the request after it in the same chunk', async () => {
  const writes: JsonRpcResponse[] = [];
  const session = createMcpStdioSession({
    write: (message) => writes.push(message as JsonRpcResponse),
  });

  session.receive(`\n${line({ jsonrpc: '2.0', id: 1, method: 'ping' })}`);
  await setImmediate();

  assert.deepEqual(writes, [{ jsonrpc: '2.0', id: 1, result: {} }]);
  await session.end();
});

test('a malformed line answers -32700 and the next line in the chunk is still served', async () => {
  const writes: JsonRpcResponse[] = [];
  const session = createMcpStdioSession({
    write: (message) => writes.push(message as JsonRpcResponse),
  });

  session.receive(`bad\n${line({ jsonrpc: '2.0', id: 5, method: 'ping' })}`);
  await session.end();

  assert.equal(writes.length, 2);
  assert.equal(writes[0]?.error?.code, -32700);
  assert.deepEqual(writes[1], { jsonrpc: '2.0', id: 5, result: {} });
});

test('a final request without a trailing newline is served at end of input', async () => {
  const writes: JsonRpcResponse[] = [];
  const session = createMcpStdioSession({
    write: (message) => writes.push(message as JsonRpcResponse),
  });

  session.receive(JSON.stringify({ jsonrpc: '2.0', id: 9, method: 'ping' }));
  await setImmediate();
  assert.deepEqual(writes, []);
  await session.end();

  assert.deepEqual(writes, [{ jsonrpc: '2.0', id: 9, result: {} }]);
});

test('tools/call requests run one at a time in arrival order', async () => {
  const tools = blockingToolCalls();

  tools.session.receive(line({ jsonrpc: '2.0', id: 'first', method: 'tools/call' }));
  tools.session.receive(line({ jsonrpc: '2.0', id: 'second', method: 'tools/call' }));
  await setImmediate();

  assert.deepEqual(tools.started, ['first']);
  tools.finish('first');
  await setImmediate();

  assert.deepEqual(tools.started, ['first', 'second']);
  tools.finish('second');
  await tools.session.end();

  assert.deepEqual(
    tools.writes.map((message) => message.id),
    ['first', 'second'],
  );
});

test('ping and tools/list are answered while a tools/call is still running', async () => {
  const tools = blockingToolCalls();

  tools.session.receive(line({ jsonrpc: '2.0', id: 'call', method: 'tools/call' }));
  tools.session.receive(line({ jsonrpc: '2.0', id: 'keepalive', method: 'ping' }));
  tools.session.receive(line({ jsonrpc: '2.0', id: 'list', method: 'tools/list' }));
  await setImmediate();

  assert.deepEqual(tools.started, ['call']);
  assert.deepEqual(
    tools.writes.map((message) => message.id),
    ['keepalive', 'list'],
  );
  tools.finish('call');
  await tools.session.end();
  assert.deepEqual(
    tools.writes.map((message) => message.id),
    ['keepalive', 'list', 'call'],
  );
});

test('notifications/cancelled aborts the running tools/call and skips a queued one, with no response for either', async () => {
  const tools = blockingToolCalls();

  tools.session.receive(line({ jsonrpc: '2.0', id: 1, method: 'tools/call' }));
  tools.session.receive(line({ jsonrpc: '2.0', id: 2, method: 'tools/call' }));
  tools.session.receive(line({ jsonrpc: '2.0', id: 3, method: 'tools/call' }));
  await setImmediate();
  // A cancellation names the request id with its JSON type: "1" is not 1.
  tools.session.receive(cancel('1'));
  await setImmediate();
  assert.equal(tools.signals.get(1)?.aborted, false);

  tools.session.receive(cancel(2));
  tools.session.receive(cancel(1));
  await setImmediate();

  assert.equal(tools.signals.get(1)?.aborted, true);
  tools.finish(1);
  await setImmediate();
  assert.deepEqual(tools.started, [1, 3]);
  tools.finish(3);
  await tools.session.end();

  assert.deepEqual(
    tools.writes.map((message) => message.id),
    [3],
  );
});

test('a cancellation in the same chunk as its tools/call stops the call before it starts', async () => {
  const tools = blockingToolCalls();

  tools.session.receive(`${line({ jsonrpc: '2.0', id: 7, method: 'tools/call' })}${cancel(7)}`);
  await tools.session.end();

  assert.deepEqual(tools.started, []);
  assert.deepEqual(tools.writes, []);
});

test('a batch refuses its tools/call elements with -32600 and serves the rest', async () => {
  const response = (await handleMcpPayload([
    { jsonrpc: '2.0', id: 'call', method: 'tools/call', params: { name: 'help' } },
    { jsonrpc: '2.0', method: 'tools/call', params: { name: 'help' } },
    { jsonrpc: '2.0', id: 'ping', method: 'ping' },
  ])) as JsonRpcResponse[];

  assert.deepEqual(
    response.map((entry) => entry.id),
    ['call', 'ping'],
  );
  assert.equal(response[0]?.error?.code, -32600);
  assert.deepEqual(response[1]?.result, {});
});

test('a batch is answered while a tools/call is still running', async () => {
  const tools = blockingToolCalls();

  tools.session.receive(line({ jsonrpc: '2.0', id: 'call', method: 'tools/call' }));
  tools.session.receive(line([{ jsonrpc: '2.0', id: 'ping', method: 'ping' }]));
  await setImmediate();

  assert.equal(tools.writes.length, 1, 'the batch answer does not wait for the tool call');
  tools.finish('call');
  await tools.session.end();
  assert.equal(tools.writes.length, 2);
});

function line(message: unknown): string {
  return `${JSON.stringify(message)}\n`;
}

function cancel(requestId: string | number): string {
  return line({ jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId } });
}

/** A session whose tools/call requests block until `finish(id)`; other requests answer at once. */
function blockingToolCalls() {
  type Id = string | number | null;
  const started: Id[] = [];
  const writes: JsonRpcResponse[] = [];
  const signals = new Map<Id, AbortSignal | undefined>();
  const completions = new Map<Id, () => void>();
  const session = createMcpStdioSession({
    handlePayload: async (payload, { signal }) => {
      const { id = null, method } = payload as { id?: Id; method?: string };
      if (method !== 'tools/call') return { jsonrpc: '2.0', id, result: {} };
      started.push(id);
      signals.set(id, signal);
      await new Promise<void>((resolve) => completions.set(id, resolve));
      return { jsonrpc: '2.0', id, result: {} };
    },
    write: (message) => {
      writes.push(message as JsonRpcResponse);
    },
  });
  return {
    session,
    started,
    writes,
    signals,
    finish: (id: Id) => completions.get(id)?.(),
  };
}
