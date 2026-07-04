import assert from 'node:assert/strict';
import { test } from 'vitest';
import type { AgentDeviceClient } from '../../client/client-types.ts';
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

test('MCP renders a non-default response level as JSON text, not misleading optimized text', async () => {
  // With responseLevel:digest the daemon returns the digest shape (no `nodes`).
  // The optimized snapshot formatter expects `nodes` and would print
  // "Snapshot: 0 nodes" — contradicting structuredContent. The text must instead
  // be the digest payload verbatim (JSON), even though mcpOutputFormat is optimized.
  const digest = { nodeCount: 3, refs: [{ ref: 'e1', label: 'Continue' }], truncated: false };
  const executor = createCommandToolExecutor({
    createClient: () => ({}) as AgentDeviceClient,
    runCommand: async () => digest,
  });

  const result = await executor.execute('snapshot', {
    mcpOutputFormat: 'optimized',
    responseLevel: 'digest',
  });

  assert.deepEqual(result.structuredContent, digest);
  assert.match(result.content[0]?.text ?? '', /^\{/);
  assert.deepEqual(JSON.parse(result.content[0]?.text ?? ''), digest);
  assert.doesNotMatch(result.content[0]?.text ?? '', /Snapshot: 0 nodes/);
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
  assert.deepEqual(
    (devicesTool.inputSchema.properties?.responseLevel as { enum?: unknown[] } | undefined)?.enum,
    ['digest', 'default', 'full'],
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

test('MCP responseLevel:digest opts into a verbosity level: sets client.responseLevel, strips the arg', async () => {
  const createdConfigs: unknown[] = [];
  const calls: unknown[] = [];
  const executor = createCommandToolExecutor({
    createClient: (config) => {
      createdConfigs.push(config);
      return {} as AgentDeviceClient;
    },
    runCommand: async (_client, name, input) => {
      calls.push({ name, input });
      return { message: `Ran ${name}` };
    },
  });

  const result = await executor.execute('wait', { responseLevel: 'digest' });

  // responseLevel maps to the client `responseLevel` config (→ meta.responseLevel on the daemon).
  assert.deepEqual(createdConfigs, [{ responseLevel: 'digest' }]);
  // responseLevel is an MCP-boundary field and must not leak into the command input.
  assert.deepEqual(calls, [{ name: 'wait', input: {} }]);
  assert.deepEqual(result.structuredContent, { message: 'Ran wait' });
});

test('MCP responseLevel absent leaves the request shape untouched (no responseLevel config)', async () => {
  const createdConfigs: unknown[] = [];
  const executor = createCommandToolExecutor({
    createClient: (config) => {
      createdConfigs.push(config);
      return {} as AgentDeviceClient;
    },
    runCommand: async () => ({ message: 'ok' }),
  });

  const absent = await executor.execute('wait', {});

  // The absent path never sets `responseLevel`; the config is byte-identical to today.
  assert.deepEqual(createdConfigs, [{}]);
  assert.deepEqual(absent.structuredContent, { message: 'ok' });
});

test('MCP responseLevel rejects unknown values at the boundary', async () => {
  const executor = createCommandToolExecutor({
    createClient: () => ({}) as AgentDeviceClient,
    runCommand: async () => ({}),
  });

  await assert.rejects(
    executor.execute('wait', { responseLevel: 'verbose' }),
    /Expected responseLevel to be one of 'digest', 'default', or 'full'\./,
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

// --- #1076 versioned refs: MCP auto-pinning ---

function createPinningExecutor(runCalls: Array<{ name: string; input: unknown }>) {
  return createCommandToolExecutor({
    createClient: () => ({}) as AgentDeviceClient,
    runCommand: async (_client, name, input) => {
      runCalls.push({ name, input });
      if (name === 'snapshot') {
        // Issues refs e2 and e37 at generation 500012.
        return {
          nodes: [{ ref: 'e2' }, { ref: 'e37' }],
          truncated: false,
          refsGeneration: 500012,
        };
      }
      if (name === 'find') {
        // A later find capture replaced the tree and issued ONLY e5 at 500013.
        return { ref: '@e5', refsGeneration: 500013 };
      }
      return { message: `Ran ${name}` };
    },
  });
}

test('MCP keeps per-ref provenance: a pre-find snapshot ref stays pinned to ITS generation', async () => {
  // THE find-blessing scenario (#1076): snapshot issues e37 at G1, a later
  // find issues e5 at G2. A plain @e37 must forward pinned to G1 — pinning it
  // to G2 would make the daemon read it as current and silently re-bless it.
  // (The daemon side of this flow — precise warning for the G1 pin after the
  // find capture replaced the tree — is covered in the provider scenario.)
  const runCalls: Array<{ name: string; input: unknown }> = [];
  const executor = createPinningExecutor(runCalls);

  await executor.execute('snapshot', { session: 'demo' });
  await executor.execute('find', { session: 'demo', query: 'Continue' });
  await executor.execute('press', { session: 'demo', target: { kind: 'ref', ref: '@e37' } });

  assert.deepEqual(runCalls[2], {
    name: 'press',
    input: { session: 'demo', target: { kind: 'ref', ref: '@e37~s500012' } },
  });
});

test('MCP pins the find-issued ref to the find generation', async () => {
  const runCalls: Array<{ name: string; input: unknown }> = [];
  const executor = createPinningExecutor(runCalls);

  await executor.execute('snapshot', { session: 'demo' });
  await executor.execute('find', { session: 'demo', query: 'Continue' });
  await executor.execute('press', { session: 'demo', target: { kind: 'ref', ref: '@e5' } });

  assert.deepEqual(runCalls[2], {
    name: 'press',
    input: { session: 'demo', target: { kind: 'ref', ref: '@e5~s500013' } },
  });
});

test('MCP auto-pins wait refs and get targets from the per-ref map', async () => {
  const runCalls: Array<{ name: string; input: unknown }> = [];
  const executor = createPinningExecutor(runCalls);

  await executor.execute('snapshot', { session: 'demo' });
  await executor.execute('wait', { session: 'demo', ref: '@e2' });
  await executor.execute('get', {
    session: 'demo',
    format: 'text',
    target: { kind: 'ref', ref: '@e37' },
  });

  assert.deepEqual(runCalls[1], {
    name: 'wait',
    input: { session: 'demo', ref: '@e2~s500012' },
  });
  assert.deepEqual(runCalls[2], {
    name: 'get',
    input: { session: 'demo', format: 'text', target: { kind: 'ref', ref: '@e37~s500012' } },
  });
});

test('MCP merges digest-level snapshot refs too', async () => {
  const runCalls: Array<{ name: string; input: unknown }> = [];
  const executor = createCommandToolExecutor({
    createClient: () => ({}) as AgentDeviceClient,
    runCommand: async (_client, name, input) => {
      runCalls.push({ name, input });
      return name === 'snapshot'
        ? { nodeCount: 1, refs: [{ ref: 'e9', label: 'Continue' }], refsGeneration: 41 }
        : {};
    },
  });

  await executor.execute('snapshot', { responseLevel: 'digest' });
  await executor.execute('press', { target: { kind: 'ref', ref: '@e9' } });

  assert.deepEqual(runCalls[1]?.input, { target: { kind: 'ref', ref: '@e9~s41' } });
});

test('MCP passes never-issued refs through unpinned (coarse floor, never guess)', async () => {
  const runCalls: Array<{ name: string; input: unknown }> = [];
  const executor = createPinningExecutor(runCalls);

  await executor.execute('snapshot', { session: 'demo' });
  // e99 was never present in any issuing response for this scope.
  await executor.execute('press', { session: 'demo', target: { kind: 'ref', ref: '@e99' } });

  assert.deepEqual(runCalls[1]?.input, { session: 'demo', target: { kind: 'ref', ref: '@e99' } });
});

test('MCP passes refs through unpinned when the pin scope has no history', async () => {
  const runCalls: Array<{ name: string; input: unknown }> = [];
  const executor = createPinningExecutor(runCalls);

  // Only OTHER session names have history.
  await executor.execute('snapshot', { session: 'other' });
  await executor.execute('press', { session: 'demo', target: { kind: 'ref', ref: '@e2' } });

  assert.deepEqual(runCalls[1]?.input, { session: 'demo', target: { kind: 'ref', ref: '@e2' } });
});

test('MCP pin scopes include the state dir: same-named sessions never cross-pollinate', async () => {
  const runCalls: Array<{ name: string; input: unknown }> = [];
  const executor = createPinningExecutor(runCalls);

  await executor.execute('snapshot', { session: 'demo', stateDir: '/state/a' });
  // Same session name against a DIFFERENT daemon state dir: no history there.
  await executor.execute('press', {
    session: 'demo',
    stateDir: '/state/b',
    target: { kind: 'ref', ref: '@e2' },
  });
  // The original scope still pins.
  await executor.execute('press', {
    session: 'demo',
    stateDir: '/state/a',
    target: { kind: 'ref', ref: '@e2' },
  });

  assert.deepEqual(runCalls[1]?.input, { session: 'demo', target: { kind: 'ref', ref: '@e2' } });
  assert.deepEqual(runCalls[2]?.input, {
    session: 'demo',
    target: { kind: 'ref', ref: '@e2~s500012' },
  });
});

test('MCP clears the whole scope when a ref-issuing response stops carrying a generation', async () => {
  const runCalls: Array<{ name: string; input: unknown }> = [];
  let issueGeneration = true;
  const executor = createCommandToolExecutor({
    createClient: () => ({}) as AgentDeviceClient,
    runCommand: async (_client, name, input) => {
      runCalls.push({ name, input });
      if (name === 'snapshot') {
        return issueGeneration
          ? { nodes: [{ ref: 'e2' }], truncated: false, refsGeneration: 4 }
          : { nodes: [{ ref: 'e2' }], truncated: false };
      }
      return {};
    },
  });

  await executor.execute('snapshot', {});
  issueGeneration = false;
  // An older daemon without refsGeneration: the remembered pins must not
  // leak onto refs the response did not vouch for.
  await executor.execute('snapshot', {});
  await executor.execute('press', { target: { kind: 'ref', ref: '@e2' } });

  assert.deepEqual(runCalls[2], {
    name: 'press',
    input: { target: { kind: 'ref', ref: '@e2' } },
  });
});

test('MCP never rewrites refs that already carry a suffix and never pins non-@ refs', async () => {
  const runCalls: Array<{ name: string; input: unknown }> = [];
  const executor = createPinningExecutor(runCalls);

  await executor.execute('snapshot', {});
  await executor.execute('press', { target: { kind: 'ref', ref: '@e2~s3' } });
  await executor.execute('press', { target: { kind: 'ref', ref: 'e2' } });

  assert.deepEqual(runCalls[1]?.input, { target: { kind: 'ref', ref: '@e2~s3' } });
  assert.deepEqual(runCalls[2]?.input, { target: { kind: 'ref', ref: 'e2' } });
});

test('MCP renders tool text from the unpinned input so the model never sees suffixes', async () => {
  const executor = createCommandToolExecutor({
    createClient: () => ({}) as AgentDeviceClient,
    runCommand: async (_client, name) =>
      name === 'snapshot'
        ? { nodes: [{ ref: 'e2' }], truncated: false, refsGeneration: 9 }
        : { message: 'Tapped @e2 (10, 20)' },
  });

  await executor.execute('snapshot', {});
  const result = await executor.execute('press', { target: { kind: 'ref', ref: '@e2' } });

  assert.doesNotMatch(result.content[0]?.text ?? '', /~s9/);
});
