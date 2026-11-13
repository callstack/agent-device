import assert from 'node:assert/strict';
import { afterEach, test, vi } from 'vitest';
import { AppError } from '@agent-device/kernel/errors';
import type { AgentDeviceClient } from '@agent-device/command-surface';
import type { ToolResult } from '../../mcp/command-tools.ts';

const createClientCalls: unknown[] = [];
const executorCalls: Array<{ name: string; input: Record<string, unknown> }> = [];
const executorDeps: unknown[] = [];
const executorSignals: Array<AbortSignal | undefined> = [];

const defaultExecuteResult: ToolResult = {
  isError: false,
  structuredContent: { ok: true },
  content: [{ type: 'text', text: 'ok' }],
};
let executeResult: (
  name: string,
  input: Record<string, unknown>,
) => Promise<ToolResult> = async () => defaultExecuteResult;

vi.mock('@agent-device/client', () => ({
  createAgentDeviceClient: (config: unknown) => {
    createClientCalls.push(config);
    return { marker: 'stub-client' } as unknown as AgentDeviceClient;
  },
}));

vi.mock('../../mcp/command-tools.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../mcp/command-tools.ts')>();
  return {
    ...actual,
    createCommandToolExecutor: (deps: unknown) => {
      executorDeps.push(deps);
      return {
        execute: async (
          name: string,
          input: Record<string, unknown>,
          options?: { signal?: AbortSignal },
        ) => {
          executorCalls.push({ name, input });
          executorSignals.push(options?.signal);
          return executeResult(name, input);
        },
      };
    },
  };
});

const { createAgentDeviceTools } = await import('../index.ts');

afterEach(() => {
  createClientCalls.length = 0;
  executorCalls.length = 0;
  executorDeps.length = 0;
  executorSignals.length = 0;
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

/** Calls a tool the way the AI SDK does: with the call's execution options. */
function executeOf(
  tools: Awaited<ReturnType<typeof createAgentDeviceTools>>['tools'],
  name: string,
  abortSignal?: AbortSignal,
) {
  const execute = tools[name]!.execute as (
    input: Record<string, unknown>,
    options: { toolCallId: string; messages: unknown[]; abortSignal?: AbortSignal },
  ) => Promise<unknown>;
  return async (input: Record<string, unknown>) =>
    await execute(input, { toolCallId: 'call-1', messages: [], abortSignal });
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
  for (const tierless of ['debug', 'metro', 'session']) {
    assert.equal(
      tierless in tools,
      false,
      `${tierless} declares no tier, so the core default leaves it out`,
    );
  }

  const schema = rawSchemaOf(tools, 'snapshot');
  assert.equal('session' in schema.properties, false, 'session is always hidden from the model');
  assert.equal('responseLevel' in schema.properties, false, 'responseLevel is always hidden');
  assert.ok('platform' in schema.properties, 'platform stays visible when not pinned');

  await executeOf(tools, 'snapshot')({ interactiveOnly: true });
  assert.deepEqual(executorCalls, [
    { name: 'snapshot', input: { interactiveOnly: true, session: 'my-session' } },
  ]);
});

test('MCP transport/config controls are hidden from the schema and cannot reach the executor', async () => {
  const { tools } = await createAgentDeviceTools({ session: 'pinned-session' });

  const schema = rawSchemaOf(tools, 'snapshot');
  for (const field of ['stateDir', 'cost', 'responseLevel']) {
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
    cost: true,
    responseLevel: 'full',
    session: 'attacker-supplied-session',
  });

  assert.deepEqual(executorCalls, [
    { name: 'snapshot', input: { interactiveOnly: true, session: 'pinned-session' } },
  ]);
});

test('the stabilization opt-out is caller policy, so no tool schema offers it', async () => {
  const { tools } = await createAgentDeviceTools({ session: 'my-session', set: 'all' });

  for (const name of ['scroll', 'swipe']) {
    assert.ok(name in tools, `${name} is part of the tool set`);
    assert.equal(
      'postGestureStabilization' in rawSchemaOf(tools, name).properties,
      false,
      `${name} offers the opt-out to the model`,
    );
  }
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

test('asks the executor for structuredContent from every tool, because execute returns it', async () => {
  await createAgentDeviceTools({ session: 'my-session' });

  // Without it, an untyped tool such as snapshot returns {} from execute.
  assert.deepEqual(executorDeps, [{ structuredContent: 'always' }]);
});

test('typed tools keep their output schema for the data host; untyped tools declare none', async () => {
  const { tools } = await createAgentDeviceTools({ session: 'my-session', set: 'all' });
  const outputSchemaOf = (name: string) =>
    (tools[name] as unknown as { outputSchema?: { jsonSchema: { required?: string[] } } })
      .outputSchema;

  assert.deepEqual(outputSchemaOf('devices')?.jsonSchema.required, ['devices']);
  assert.equal(outputSchemaOf('snapshot'), undefined);
});

test("the AI SDK call's abortSignal reaches the executor", async () => {
  const { tools } = await createAgentDeviceTools({ session: 'my-session' });
  const controller = new AbortController();

  await executeOf(tools, 'snapshot', controller.signal)({});

  assert.deepEqual(executorSignals, [controller.signal]);
});
