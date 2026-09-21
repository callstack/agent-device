import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, test, vi } from 'vitest';
import { createAgentDeviceClient } from '../../agent-device-client.ts';
import type { AgentDeviceDaemonTransport } from '@agent-device/contracts/client';
import type { AgentDeviceClient } from '../../client/client-types.ts';
import type { CommandExecutionResult } from '../../commands/command-surface.ts';
import { createCommandToolExecutor, listCommandTools } from '../command-tools.ts';
import { COMMAND_OUTPUT_SCHEMAS } from '../command-output-schemas.ts';
import { validateAgainstSchema } from './output-schema-validator.ts';
import { mkdtempForTestSync } from '../../__tests__/test-utils/tmp-dir.ts';

afterEach(() => {
  vi.unstubAllEnvs();
  if (temporaryDirectory) {
    fs.rmSync(temporaryDirectory, { recursive: true, force: true });
    temporaryDirectory = undefined;
  }
});

let temporaryDirectory: string | undefined;

test('MCP collection results use object envelopes without changing object results or text', async () => {
  const results = {
    devices: [
      {
        id: 'device-1',
        name: 'iPhone',
        platform: 'ios',
        target: 'mobile',
        kind: 'device',
        identifiers: {},
      },
    ],
    apps: ['com.example.app'],
    wait: { waitedMs: 10 },
  } satisfies Record<'devices' | 'apps' | 'wait', CommandExecutionResult>;
  const executor = createCommandToolExecutor({
    createClient: () => ({}) as AgentDeviceClient,
    runCommand: async (_client, name) => results[name as keyof typeof results],
  });

  const devices = await executor.execute('devices', {});
  const apps = await executor.execute('apps', {});
  const wait = await executor.execute('wait', {});

  assert.deepEqual(devices.structuredContent, {
    devices: [
      { id: 'device-1', name: 'iPhone', platform: 'ios', target: 'mobile', kind: 'device' },
    ],
  });
  assert.deepEqual(apps.structuredContent, { apps: results.apps });
  assert.deepEqual(wait.structuredContent, results.wait);
  assert.equal(devices.content[0]?.text, 'iPhone (ios device target=mobile)');
  assert.equal(apps.content[0]?.text, 'com.example.app');

  for (const [name, result] of [
    ['devices', devices],
    ['apps', apps],
  ] as const) {
    const schema = listCommandTools().find((tool) => tool.name === name)?.outputSchema;
    assert.ok(schema, `${name} advertises an output schema`);
    assert.deepEqual(validateAgainstSchema(result.structuredContent, schema), []);
  }
});

test('MCP open keeps device-selection evidence in structured content and JSON text data', async () => {
  const openResult = {
    session: 'selected',
    selection: {
      reason: 'single-booted-local',
      source: 'local',
      candidateCount: 2,
      bootOccurred: false,
    },
  };
  const executor = createCommandToolExecutor({
    createClient: () => ({}) as AgentDeviceClient,
    runCommand: async () => openResult,
  });

  const result = await executor.execute('open', { app: 'Settings', mcpOutputFormat: 'json' });

  assert.deepEqual(result.structuredContent, openResult);
  assert.deepEqual(JSON.parse(result.content[0]?.text ?? '{}').selection, openResult.selection);
});

test('MCP advertises and round-trips the strict wait absent field', async () => {
  let observedInput: Record<string, unknown> | undefined;
  const executor = createCommandToolExecutor({
    createClient: () => ({}) as AgentDeviceClient,
    runCommand: async (_client, _name, input) => {
      observedInput = input;
      return { waitedMs: 0 };
    },
  });
  const waitTool = listCommandTools().find((tool) => tool.name === 'wait');
  assert.equal(
    (waitTool?.inputSchema.properties?.absent as { type?: string } | undefined)?.type,
    'string',
  );

  const result = await executor.execute('wait', {
    absent: 'label="Removed"',
    timeoutMs: 5000,
  });

  assert.equal(result.isError, false);
  assert.deepEqual(observedInput, { absent: 'label="Removed"', timeoutMs: 5000 });
});

test('MCP fill projects target-bound unconfirmed verification through its advertised schema', async () => {
  const fillResult = {
    targetKind: 'point',
    x: 100,
    y: 50,
    text: '0501234567',
    verification: 'unconfirmed',
    requested: '0501234567',
    before: '12 123 4567',
    after: '05 012 3456',
    target: {
      resourceId: 'com.example:id/phone',
      className: 'android.widget.EditText',
      packageName: 'com.example',
      rect: { x: 0, y: 0, width: 200, height: 100 },
    },
  } satisfies CommandExecutionResult<'fill'>;
  const executor = createCommandToolExecutor({
    createClient: () => ({}) as AgentDeviceClient,
    runCommand: async () => fillResult,
  });

  const fillTool = listCommandTools().find((tool) => tool.name === 'fill');
  assert.ok(fillTool?.outputSchema);
  assert.equal(fillTool.outputSchema, COMMAND_OUTPUT_SCHEMAS.fill);
  const unconfirmedBranch = fillTool.outputSchema.oneOf?.find(
    (branch) =>
      (branch.properties?.verification as { const?: unknown } | undefined)?.const === 'unconfirmed',
  );
  assert.ok(unconfirmedBranch, 'fill schema must advertise the unconfirmed verification branch');
  assert.deepEqual(unconfirmedBranch.required, [
    'targetKind',
    'text',
    'verification',
    'requested',
    'before',
    'after',
    'target',
  ]);
  assert.deepEqual(unconfirmedBranch.properties?.target?.required, [
    'resourceId',
    'className',
    'packageName',
    'rect',
  ]);

  const result = await executor.execute('fill', {
    target: { kind: 'point', x: 100, y: 50 },
    text: fillResult.requested,
  });
  assert.deepEqual(result.structuredContent, fillResult);
  assert.deepEqual(validateAgainstSchema(result.structuredContent, fillTool.outputSchema), []);
  const { target: _target, ...missingTarget } = fillResult;
  assert.notDeepEqual(validateAgainstSchema(missingTarget, fillTool.outputSchema), []);
});

test('MCP fold advertises the native-panel discriminator and rejects a screen missing it', async () => {
  const foldResult = {
    action: 'fold',
    pose: 'open',
    hingeAngleDegrees: 180,
    screen: { display: 'LCD-1', coordinateSpace: 'native-panel', widthPt: 669, heightPt: 951 },
    message:
      'Folded to open (hinge 180°, LCD-1 native panel 669x951pt, not snapshot coordinates); refs from before the pose change are stale',
  } satisfies CommandExecutionResult<'fold'>;
  const executor = createCommandToolExecutor({
    createClient: () => ({}) as AgentDeviceClient,
    runCommand: async () => foldResult,
  });

  const foldTool = listCommandTools().find((tool) => tool.name === 'fold');
  assert.ok(foldTool?.outputSchema);
  assert.equal(foldTool.outputSchema, COMMAND_OUTPUT_SCHEMAS.fold);

  const result = await executor.execute('fold', { pose: 'open' });
  assert.deepEqual(result.structuredContent, foldResult);
  assert.deepEqual(validateAgainstSchema(result.structuredContent, foldTool.outputSchema), []);

  // A panel report that drops the discriminator no longer validates: the coordinate-space contract
  // is required, not inferable from the numbers alone.
  const { coordinateSpace: _coordinateSpace, ...screenWithoutDiscriminator } = foldResult.screen;
  assert.notDeepEqual(
    validateAgainstSchema(
      { ...foldResult, screen: screenWithoutDiscriminator },
      foldTool.outputSchema,
    ),
    [],
  );
});

test('MCP applies config-backed command defaults; explicit operator input is refused', async () => {
  const home = mkdtempForTestSync('agent-device-mcp-config-');
  temporaryDirectory = home;
  const configuredXctestrun = path.join(home, 'configured.xctestrun');
  fs.mkdirSync(path.join(home, '.agent-device'));
  fs.writeFileSync(
    path.join(home, '.agent-device', 'config.json'),
    JSON.stringify({ iosXctestrunFile: configuredXctestrun, appsFilter: 'all' }),
  );
  vi.stubEnv('HOME', home);

  const calls: Array<Parameters<AgentDeviceDaemonTransport>[0]> = [];
  const transport: AgentDeviceDaemonTransport = async (request) => {
    calls.push(request);
    return { ok: true, data: { nodes: [], truncated: false } };
  };
  const executor = createCommandToolExecutor({
    createClient: (config) => createAgentDeviceClient(config, { transport }),
  });

  await executor.execute('snapshot', {});
  // Operator-owned inputs are env/config-only: the explicit value is refused
  // with guidance instead of overriding the operator's configuration.
  const refused = await executor.execute('snapshot', {
    iosXctestrunFile: '/explicit/runner.xctestrun',
  });

  assert.deepEqual(
    calls.map((request) => request.flags?.iosXctestrunFile),
    [configuredXctestrun],
  );
  assert.equal(refused.isError, true);
  assert.match(
    refused.content[0]?.text ?? '',
    /iosXctestrunFile is not accepted as a tool argument/,
  );
  assert.ok(calls.every((request) => request.command === 'snapshot'));
  assert.ok(calls.every((request) => request.flags?.appsFilter === undefined));
});
