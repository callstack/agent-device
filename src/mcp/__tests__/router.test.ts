import assert from 'node:assert/strict';
import { setImmediate } from 'node:timers/promises';
import { test } from 'vitest';
import { listMcpExposedCommandNames } from '../../command-catalog.ts';
import { handleMcpMessage } from '../router.ts';
import { createMcpPayloadQueue, handleMcpPayload } from '../server.ts';

test('MCP exposes every automatable CLI command as a structured direct tool', async () => {
  const response = await handleMcpMessage({
    jsonrpc: '2.0',
    id: 1,
    method: 'tools/list',
  });

  assert.ok(response && 'result' in response);
  const tools = (response.result as { tools: Array<{ name: string }> }).tools.map(
    (tool) => tool.name,
  );
  const expectedToolNames = listMcpExposedCommandNames().sort();

  assert.deepEqual(tools.sort(), expectedToolNames);

  const fillTool = (response.result as { tools: Array<Record<string, unknown>> }).tools.find(
    (tool) => tool.name === 'fill',
  );
  assert.ok(fillTool);
  const fillProperties = (fillTool.inputSchema as { properties: Record<string, unknown> })
    .properties;
  assert.ok(!('positionals' in fillProperties));
  assert.ok('target' in fillProperties);

  const batchTool = (response.result as { tools: Array<Record<string, unknown>> }).tools.find(
    (tool) => tool.name === 'batch',
  );
  assert.ok(batchTool);
  assert.ok(!JSON.stringify(batchTool.inputSchema).includes('"positionals"'));
  assert.ok(!JSON.stringify(batchTool.inputSchema).includes('"flags"'));

  const invalidFillResponse = await handleMcpMessage({
    jsonrpc: '2.0',
    id: 2,
    method: 'tools/call',
    params: { name: 'fill', arguments: {} },
  });
  assert.ok(invalidFillResponse && 'result' in invalidFillResponse);
  assert.equal((invalidFillResponse.result as { isError: boolean }).isError, true);
  assert.match(JSON.stringify(invalidFillResponse.result), /Expected target to be set/);
});

test('MCP JSON-RPC batches return responses in request order and skip notifications', async () => {
  const response = await handleMcpPayload([
    { jsonrpc: '2.0', id: 'first', method: 'ping' },
    { jsonrpc: '2.0', method: 'notifications/initialized' },
    { jsonrpc: '2.0', id: 'second', method: 'ping' },
  ]);

  assert.deepEqual(
    (response as Array<{ id: string }>).map((entry) => entry.id),
    ['first', 'second'],
  );
});

test('MCP stdio payload queue serializes separate messages', async () => {
  const started: JsonRpcId[] = [];
  const writes: unknown[] = [];
  const completions = new Map<JsonRpcId, (response: unknown) => void>();
  const queue = createMcpPayloadQueue({
    handlePayload: async (message) => {
      const id = Array.isArray(message) ? null : ((message as { id?: JsonRpcId }).id ?? null);
      started.push(id);
      return await new Promise((resolve) => completions.set(id, resolve));
    },
    write: (message) => {
      writes.push(message);
    },
  });

  queue.push({ jsonrpc: '2.0', id: 'first', method: 'tools/call' });
  queue.push({ jsonrpc: '2.0', id: 'second', method: 'tools/call' });
  await Promise.resolve();

  assert.deepEqual(started, ['first']);
  completions.get('first')?.({ jsonrpc: '2.0', id: 'first', result: {} });
  await setImmediate();

  assert.deepEqual(started, ['first', 'second']);
  completions.get('second')?.({ jsonrpc: '2.0', id: 'second', result: {} });
  await queue.idle();

  assert.deepEqual(
    writes.map((message) => (message as { id: JsonRpcId }).id),
    ['first', 'second'],
  );
});

type JsonRpcId = string | number | null;
