import assert from 'node:assert/strict';
import { test } from 'vitest';
import {
  commandDescriptors,
  resolveCommandRecordingEffect,
} from '@agent-device/command-registry/registry';
import { createMcpMessageHandler } from '../router.ts';

type AdvertisedTool = {
  name: string;
  title?: string;
  annotations?: { readOnlyHint?: boolean; destructiveHint?: boolean };
};

for (const structured of [false, true]) {
  test(`tools/list declares titles and effects for every tool (structured=${structured})`, async () => {
    const response = await createMcpMessageHandler({ structured })({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/list',
    });
    assert.ok(response && 'result' in response);
    const { tools } = response.result as { tools: AdvertisedTool[] };
    assert.ok(tools.length > 0);
    for (const tool of tools) {
      assert.ok(tool.title?.trim(), `${tool.name}: missing title`);
      assert.equal(typeof tool.annotations?.readOnlyHint, 'boolean', tool.name);
      assert.equal(typeof tool.annotations?.destructiveHint, 'boolean', tool.name);
      if (tool.annotations?.readOnlyHint) assertReadOnlyRuntimeEffects(tool);
    }
    for (const name of ['devices', 'artifacts', 'capabilities', 'events', 'help']) {
      assert.deepEqual(
        tools.find((tool) => tool.name === name)?.annotations,
        {
          readOnlyHint: true,
          destructiveHint: false,
        },
        name,
      );
    }
    for (const name of [
      'apps',
      'appstate',
      'get',
      'is',
      'snapshot',
      'wait',
      'doctor',
      'screenshot',
    ]) {
      assert.deepEqual(
        tools.find((tool) => tool.name === name)?.annotations,
        {
          readOnlyHint: false,
          destructiveHint: false,
        },
        name,
      );
    }
    for (const name of ['find', 'clipboard', 'session', 'batch', 'replay', 'test', 'shutdown']) {
      assert.deepEqual(
        tools.find((tool) => tool.name === name)?.annotations,
        {
          readOnlyHint: false,
          destructiveHint: true,
        },
        name,
      );
    }
  });
}

function assertReadOnlyRuntimeEffects(tool: AdvertisedTool): void {
  assert.notEqual(
    resolveCommandRecordingEffect({ command: tool.name, positionals: [] }),
    'mutates-app',
    `${tool.name}: a recorded app mutation cannot be read-only`,
  );
  const descriptor = commandDescriptors.find((entry) => entry.name === tool.name);
  if (tool.name === 'help') return;
  assert.ok(descriptor, `${tool.name}: missing command descriptor`);
  const execution = descriptor.platformExecution;
  if (execution.kind !== 'device-runtime') return;
  const uses = 'uses' in execution ? execution.uses : [execution.use];
  for (const use of uses) {
    const operations = [...use.required, ...use.preferred, ...(use.conditional ?? [])];
    for (const operation of ['ensureReady', 'bootTarget', 'bootTargetHeadless'] as const) {
      assert.ok(
        !operations.includes(operation),
        `${tool.name}: read-only tool declares ${operation}`,
      );
    }
  }
}
