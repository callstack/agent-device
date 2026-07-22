import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, test, vi } from 'vitest';
import { createAgentDeviceClient } from '../../agent-device-client.ts';
import type { AgentDeviceClient, AgentDeviceDaemonTransport } from '../../client/client-types.ts';
import type { CommandExecutionResult } from '../../commands/command-surface.ts';
import { createCommandToolExecutor, listCommandTools } from '../command-tools.ts';
import { validateAgainstSchema } from './output-schema-validator.ts';

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

test('MCP applies config-backed command defaults with explicit-input precedence and applicability', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-device-mcp-config-'));
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
  await executor.execute('snapshot', { iosXctestrunFile: '/explicit/runner.xctestrun' });

  assert.deepEqual(
    calls.map((request) => request.flags?.iosXctestrunFile),
    [configuredXctestrun, '/explicit/runner.xctestrun'],
  );
  assert.ok(calls.every((request) => request.command === 'snapshot'));
  assert.ok(calls.every((request) => request.flags?.appsFilter === undefined));
});
