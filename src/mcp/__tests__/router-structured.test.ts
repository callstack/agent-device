import assert from 'node:assert/strict';
import { afterEach, beforeEach, test, vi } from 'vitest';
import * as daemonClient from '@agent-device/daemon-client';
import { createMcpMessageHandler, type McpMessageHandler } from '../router.ts';
import { validateAgainstSchema } from './output-schema-validator.ts';

type Tool = { name: string; outputSchema?: Record<string, unknown> };
type CallResult = {
  isError: boolean;
  structuredContent?: unknown;
  content: Array<{ text: string }>;
};

const DEVICE = {
  platform: 'ios',
  target: 'mobile',
  kind: 'simulator',
  id: 'sim-1',
  name: 'iPhone',
};

beforeEach(() => {
  // The whole route below the daemon transport is real: router, executor, client, formatter.
  vi.spyOn(daemonClient, 'createEnsuredDaemonTransport').mockReturnValue(async (req) => {
    if (req.command !== 'devices') throw new Error(`unexpected daemon command ${req.command}`);
    return { ok: true, data: { devices: [{ ...DEVICE, booted: true }] } } as never;
  });
});

const handleMcpMessage = createMcpMessageHandler({ structured: false });

afterEach(() => {
  vi.restoreAllMocks();
});

async function listTools(handle: McpMessageHandler): Promise<Tool[]> {
  const response = await handle({ jsonrpc: '2.0', id: 'list', method: 'tools/list' });
  assert.ok(response && 'result' in response);
  return (response.result as { tools: Tool[] }).tools;
}

async function callDevices(handle: McpMessageHandler): Promise<CallResult> {
  const response = await handle({
    jsonrpc: '2.0',
    id: 'call',
    method: 'tools/call',
    params: { name: 'devices', arguments: {} },
  });
  assert.ok(response && 'result' in response);
  return response.result as CallResult;
}

test('the default server advertises no outputSchema and returns text only', async () => {
  const tools = await listTools(handleMcpMessage);
  assert.deepEqual(
    tools.filter((tool) => 'outputSchema' in tool).map((tool) => tool.name),
    [],
  );

  const result = await callDevices(handleMcpMessage);
  assert.equal(result.isError, false, result.content[0]?.text);
  assert.equal('structuredContent' in result, false);
  assert.equal(result.content[0]?.text, 'iPhone (ios simulator target=mobile) booted=true');
});

test('a structured server advertises outputSchemas and returns structuredContent that matches them', async () => {
  const structured = createMcpMessageHandler({ structured: true });
  const tools = await listTools(structured);
  const devicesSchema = tools.find((tool) => tool.name === 'devices')?.outputSchema;
  assert.ok(devicesSchema);
  assert.ok(tools.find((tool) => tool.name === 'press')?.outputSchema);

  const result = await callDevices(structured);
  assert.equal(result.isError, false, result.content[0]?.text);
  assert.deepEqual(result.structuredContent, { devices: [{ ...DEVICE, booted: true }] });
  assert.deepEqual(validateAgainstSchema(result.structuredContent, devicesSchema), []);
});

test('a tool call that fails before reaching a command follows the server mode', async () => {
  const call = { jsonrpc: '2.0', id: 'bad', method: 'tools/call' } as const;
  const params = { name: 'no-such-tool', arguments: {} };
  const structured = await createMcpMessageHandler({ structured: true })({ ...call, params });
  const text = await handleMcpMessage({ ...call, params });

  assert.ok(structured && 'result' in structured && text && 'result' in text);
  const structuredResult = structured.result as CallResult;
  assert.equal(structuredResult.isError, true);
  assert.equal((structuredResult.structuredContent as { code?: string }).code, 'INVALID_ARGS');
  assert.equal('structuredContent' in (text.result as CallResult), false);
  assert.match((text.result as CallResult).content[0]?.text ?? '', /^Error \(INVALID_ARGS\)/);
});
