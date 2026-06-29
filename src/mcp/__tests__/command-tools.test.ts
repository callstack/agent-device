import assert from 'node:assert/strict';
import { test } from 'vitest';
import type { AgentDeviceClient } from '../../client-types.ts';
import { createCommandToolExecutor, listCommandTools } from '../command-tools.ts';

test('MCP command tool executor hides client creation behind an execution adapter', async () => {
  const client = {} as AgentDeviceClient;
  const createdConfigs: unknown[] = [];
  const calls: unknown[] = [];
  const executor = createCommandToolExecutor({
    createClient: (config) => {
      createdConfigs.push(config);
      return client;
    },
    runCommand: async (actualClient, name, input) => {
      calls.push({ client: actualClient, name, input });
      return { message: `Ran ${name}`, ok: true };
    },
  });

  const result = await executor.execute('wait', {
    stateDir: '/tmp/agent-device-mcp',
    mcpOutputFormat: 'optimized',
  });

  assert.deepEqual(createdConfigs, [{ stateDir: '/tmp/agent-device-mcp' }]);
  assert.deepEqual(calls, [
    {
      client,
      name: 'wait',
      input: {},
    },
  ]);
  assert.deepEqual(result.structuredContent, { message: 'Ran wait', ok: true });
  assert.equal(result.content[0]?.text, 'Ran wait');
});

test('MCP command tool executor renders optimized snapshot text by default', async () => {
  const executor = createCommandToolExecutor({
    createClient: () => ({}) as AgentDeviceClient,
    runCommand: async () => ({
      nodes: [
        {
          ref: 'e1',
          index: 0,
          depth: 0,
          type: 'Button',
          label: 'Continue',
          enabled: true,
        },
      ],
      truncated: false,
    }),
  });

  const result = await executor.execute('snapshot', {});

  assert.match(result.content[0]?.text ?? '', /@e1 \[button\] "Continue"/);
  assert.doesNotMatch(result.content[0]?.text ?? '', /^\{/);
});

test('MCP command tool executor renders JSON text when requested', async () => {
  const executor = createCommandToolExecutor({
    createClient: () => ({}) as AgentDeviceClient,
    runCommand: async (_client, _name, input) => {
      assert.deepEqual(input, {});
      return {
        nodes: [
          {
            ref: 'e1',
            index: 0,
            depth: 0,
            type: 'Button',
            label: 'Continue',
            enabled: true,
          },
        ],
        truncated: false,
      };
    },
  });

  const result = await executor.execute('snapshot', { mcpOutputFormat: 'json' });

  assert.match(result.content[0]?.text ?? '', /^\{\n  "nodes": \[/);
  assert.match(result.content[0]?.text ?? '', /"label": "Continue"/);
});

test('MCP tool schemas add MCP client config fields at the MCP boundary', () => {
  const devicesTool = listCommandTools().find((tool) => tool.name === 'devices');

  assert.ok(devicesTool);
  assert.ok('stateDir' in (devicesTool.inputSchema.properties ?? {}));
  assert.deepEqual(
    (devicesTool.inputSchema.properties?.mcpOutputFormat as { enum?: unknown[] } | undefined)?.enum,
    ['optimized', 'json'],
  );
  assert.equal(
    (devicesTool.inputSchema.properties?.includeCost as { type?: string } | undefined)?.type,
    'boolean',
  );
});

test('MCP includeCost:true opts into agent-cost: sets client.cost, strips the arg, surfaces cost', async () => {
  const createdConfigs: unknown[] = [];
  const calls: unknown[] = [];
  const executor = createCommandToolExecutor({
    createClient: (config) => {
      createdConfigs.push(config);
      return {} as AgentDeviceClient;
    },
    runCommand: async (_client, name, input) => {
      calls.push({ name, input });
      return { message: `Ran ${name}`, cost: { wallClockMs: 42 } };
    },
  });

  const result = await executor.execute('wait', { includeCost: true });

  // includeCost maps to the client `cost` config (→ meta.includeCost on the daemon).
  assert.deepEqual(createdConfigs, [{ cost: true }]);
  // includeCost is an MCP-boundary field and must not leak into the command input.
  assert.deepEqual(calls, [{ name: 'wait', input: {} }]);
  // The daemon-provided cost rides through structuredContent unchanged.
  assert.deepEqual(result.structuredContent, { message: 'Ran wait', cost: { wallClockMs: 42 } });
});

test('MCP includeCost absent/false leaves the request shape untouched (no cost config)', async () => {
  const createdConfigs: unknown[] = [];
  const executor = createCommandToolExecutor({
    createClient: (config) => {
      createdConfigs.push(config);
      return {} as AgentDeviceClient;
    },
    runCommand: async () => ({ message: 'ok' }),
  });

  const absent = await executor.execute('wait', {});
  const explicitFalse = await executor.execute('wait', { includeCost: false });

  // Neither path sets `cost` on the client config; both are byte-identical configs.
  assert.deepEqual(createdConfigs, [{}, {}]);
  assert.deepEqual(absent.structuredContent, { message: 'ok' });
  assert.equal(JSON.stringify(absent), JSON.stringify(explicitFalse));
});

test('MCP includeCost rejects non-boolean values at the boundary', async () => {
  const executor = createCommandToolExecutor({
    createClient: () => ({}) as AgentDeviceClient,
    runCommand: async () => ({}),
  });

  await assert.rejects(
    executor.execute('wait', { includeCost: 'yes' }),
    /Expected includeCost to be a boolean\./,
  );
});

test('MCP typed commands advertise an outputSchema with the contract discriminant', () => {
  const tools = listCommandTools();

  // keyboard is a flat closed shape: platform + action discriminants at the top.
  const keyboard = tools.find((tool) => tool.name === 'keyboard');
  assert.ok(keyboard);
  assert.ok(keyboard.outputSchema);
  assert.equal(keyboard.outputSchema.type, 'object');
  assert.deepEqual(
    (keyboard.outputSchema.properties?.action as { enum?: unknown[] } | undefined)?.enum,
    ['status', 'dismiss', 'enter'],
  );
  assert.deepEqual(
    (keyboard.outputSchema.properties?.platform as { enum?: unknown[] } | undefined)?.enum,
    ['android', 'ios'],
  );

  // clipboard is a discriminated union on `action`, modeled as oneOf branches.
  const clipboard = tools.find((tool) => tool.name === 'clipboard');
  assert.ok(clipboard);
  assert.ok(clipboard.outputSchema);
  const clipboardActions = (clipboard.outputSchema.oneOf ?? []).map(
    (branch) => (branch.properties?.action as { const?: unknown } | undefined)?.const,
  );
  assert.deepEqual(clipboardActions, ['read', 'write']);
});

test('MCP untyped tools stay byte-identical: no outputSchema key', () => {
  const tools = listCommandTools();

  // snapshot is intentionally absent from the typed registry (dynamic shape).
  const snapshot = tools.find((tool) => tool.name === 'snapshot');
  assert.ok(snapshot);
  assert.equal('outputSchema' in snapshot, false);

  // devices is likewise untyped.
  const devices = tools.find((tool) => tool.name === 'devices');
  assert.ok(devices);
  assert.equal('outputSchema' in devices, false);
});

test('MCP boot structuredContent is consistent with its advertised outputSchema', async () => {
  const bootResult = {
    platform: 'ios',
    target: 'mobile',
    device: 'iPhone 16',
    id: 'UDID-123',
    kind: 'simulator',
    booted: true,
  };
  const executor = createCommandToolExecutor({
    createClient: () => ({}) as AgentDeviceClient,
    runCommand: async () => bootResult,
  });

  const bootTool = listCommandTools().find((tool) => tool.name === 'boot');
  assert.ok(bootTool?.outputSchema);
  const required = bootTool.outputSchema.required ?? [];
  for (const key of required) {
    assert.ok(key in bootResult, `boot result is missing required outputSchema key: ${key}`);
  }

  const result = await executor.execute('boot', {});
  assert.deepEqual(result.structuredContent, bootResult);
});

test('MCP session tool exposes state-dir resolution without a daemon round-trip', async () => {
  const sessionTool = listCommandTools().find((tool) => tool.name === 'session');
  assert.ok(sessionTool);
  assert.deepEqual(
    (sessionTool.inputSchema.properties?.action as { enum?: unknown[] } | undefined)?.enum,
    ['list', 'state-dir'],
  );

  const executor = createCommandToolExecutor({
    createClient: () =>
      ({
        sessions: { stateDir: async () => '/tmp/agent-device-dev-state' },
      }) as unknown as AgentDeviceClient,
  });
  const result = await executor.execute('session', { action: 'state-dir' });

  assert.deepEqual(result.structuredContent, { stateDir: '/tmp/agent-device-dev-state' });
});
