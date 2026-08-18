import assert from 'node:assert/strict';
import { afterEach, test, vi } from 'vitest';
import { AppError } from '@agent-device/kernel/errors';
import type { AgentDeviceClient } from '../../client/client-types.ts';
import type { ToolResult } from '../../mcp/command-tools.ts';

const createClientCalls: unknown[] = [];
const executorCalls: Array<{ name: string; input: Record<string, unknown> }> = [];

const defaultExecuteResult: ToolResult = {
  isError: false,
  structuredContent: { ok: true },
  content: [{ type: 'text', text: 'ok' }],
};
let executeResult: (
  name: string,
  input: Record<string, unknown>,
) => Promise<ToolResult> = async () => defaultExecuteResult;

vi.mock('../../agent-device-client.ts', () => ({
  createAgentDeviceClient: (config: unknown) => {
    createClientCalls.push(config);
    return { marker: 'stub-client' } as unknown as AgentDeviceClient;
  },
}));

vi.mock('../../mcp/command-tools.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../mcp/command-tools.ts')>();
  return {
    ...actual,
    createCommandToolExecutor: () => ({
      execute: async (name: string, input: Record<string, unknown>) => {
        executorCalls.push({ name, input });
        return executeResult(name, input);
      },
    }),
  };
});

const { createAgentDeviceTools } = await import('../index.ts');

afterEach(() => {
  createClientCalls.length = 0;
  executorCalls.length = 0;
  executeResult = async () => defaultExecuteResult;
});

// jsonSchema() (from the real, installed `ai` package) stores the raw schema
// under `.jsonSchema`, so this reads exactly what the model would see.
function rawSchemaOf(
  tools: Awaited<ReturnType<typeof createAgentDeviceTools>>['tools'],
  name: string,
) {
  return (
    tools[name] as unknown as {
      inputSchema: { jsonSchema: { properties: Record<string, unknown> } };
    }
  ).inputSchema.jsonSchema;
}

function executeOf(
  tools: Awaited<ReturnType<typeof createAgentDeviceTools>>['tools'],
  name: string,
) {
  return tools[name]!.execute as (input: Record<string, unknown>) => Promise<unknown>;
}

test('defaults to the core tool set and pins the session for every call', async () => {
  const { tools, client, toolApproval } = await createAgentDeviceTools({ session: 'my-session' });

  assert.deepEqual(createClientCalls, [{ session: 'my-session' }]);
  assert.equal((client as unknown as { marker: string }).marker, 'stub-client');
  assert.equal(toolApproval, undefined);

  assert.ok('snapshot' in tools, 'snapshot is core-tier');
  assert.equal(
    'devices' in tools,
    false,
    'devices is extended-tier, excluded from the core default',
  );

  const schema = rawSchemaOf(tools, 'snapshot');
  assert.equal('session' in schema.properties, false, 'session is always hidden from the model');
  assert.equal('mcpOutputFormat' in schema.properties, false, 'mcpOutputFormat is always hidden');
  assert.ok('platform' in schema.properties, 'platform stays visible when not pinned');

  await executeOf(tools, 'snapshot')({ interactiveOnly: true });
  assert.deepEqual(executorCalls, [
    { name: 'snapshot', input: { interactiveOnly: true, session: 'my-session' } },
  ]);
});

test('MCP transport/config controls are hidden from the schema and cannot reach the executor', async () => {
  const { tools } = await createAgentDeviceTools({ session: 'pinned-session' });

  const schema = rawSchemaOf(tools, 'snapshot');
  for (const field of ['stateDir', 'includeCost', 'responseLevel', 'mcpOutputFormat']) {
    assert.equal(field in schema.properties, false, `${field} must not be model-visible`);
  }

  // Simulate a caller that bypasses schema validation (e.g. a non-conforming
  // provider) and supplies these fields directly: the pinned session must
  // still hold, and none of them may reach the shared executor.
  await executeOf(
    tools,
    'snapshot',
  )({
    interactiveOnly: true,
    stateDir: '/tmp/attacker-controlled-state-dir',
    includeCost: true,
    responseLevel: 'full',
    mcpOutputFormat: 'json',
    session: 'attacker-supplied-session',
  });

  assert.deepEqual(executorCalls, [
    { name: 'snapshot', input: { interactiveOnly: true, session: 'pinned-session' } },
  ]);
});

test("set: 'all' includes extended-tier commands too", async () => {
  const { tools } = await createAgentDeviceTools({ session: 's', set: 'all' });
  assert.ok('devices' in tools, 'set: all reaches every MCP-exposed command, not just core');
  assert.ok(Object.keys(tools).length > 20);
});

test('platform is pinned per call and removed from the input schema', async () => {
  const { tools } = await createAgentDeviceTools({ session: 's', platform: 'ios' });

  const schema = rawSchemaOf(tools, 'open');
  assert.equal('platform' in schema.properties, false);

  await executeOf(tools, 'open')({ app: 'com.example.app' });
  assert.deepEqual(executorCalls, [
    { name: 'open', input: { app: 'com.example.app', session: 's', platform: 'ios' } },
  ]);
});

test('a command error is re-thrown as the normalized AppError, not swallowed', async () => {
  executeResult = async () => ({
    isError: true,
    structuredContent: {
      code: 'DEVICE_NOT_FOUND',
      message: 'No device matched the selector',
      details: { hint: 'try a broader selector' },
    },
    content: [{ type: 'text', text: 'Error (DEVICE_NOT_FOUND): No device matched the selector' }],
  });

  const { tools } = await createAgentDeviceTools({ session: 's' });

  await assert.rejects(executeOf(tools, 'snapshot')({}), (error: unknown) => {
    assert.ok(error instanceof AppError);
    assert.equal(error.code, 'DEVICE_NOT_FOUND');
    assert.match(error.message, /No device matched the selector/);
    return true;
  });
});

test('approval is returned as toolApproval, ready for ToolLoopAgent', async () => {
  const { toolApproval } = await createAgentDeviceTools({
    session: 's',
    approval: { close: 'user-approval' },
  });
  assert.deepEqual(toolApproval, { close: 'user-approval' });
});
