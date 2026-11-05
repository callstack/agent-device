import assert from 'node:assert/strict';
import { test } from 'vitest';
import type { AgentDeviceClient } from '@agent-device/command-surface';
import { createCommandToolExecutor } from '../command-tools.ts';

test('MCP returns structuredContent for typed tools, and for untyped tools only on request', async () => {
  const snapshotResult = {
    nodes: [
      { ref: 'e2', type: 'Button', label: 'Save', rect: { x: 1.5, y: 2.5, width: 3, height: 4 } },
    ],
    truncated: false,
  };
  const executor = createCommandToolExecutor({
    createClient: () => ({}) as AgentDeviceClient,
    runCommand: async (_client, name) =>
      name === 'snapshot' ? snapshotResult : { message: 'Tapped @e2 (10, 20)' },
  });

  const compact = await executor.execute('snapshot', {});
  assert.equal(compact.structuredContent, undefined);
  assert.match(compact.content[0]?.text ?? '', /@e2 \[button\] "Save"/);

  const json = await executor.execute('snapshot', { mcpOutputFormat: 'json' });
  assert.deepEqual(json.structuredContent, snapshotResult);

  const press = await executor.execute('press', { target: { kind: 'ref', ref: '@e2' } });
  assert.deepEqual(press.structuredContent, { message: 'Tapped @e2 (10, 20)' });
});

test('a data host gets structuredContent from untyped tools by default', async () => {
  const snapshotResult = { nodes: [{ ref: 'e2', label: 'Save' }], truncated: false };
  const executor = createCommandToolExecutor({
    createClient: () => ({}) as AgentDeviceClient,
    runCommand: async () => snapshotResult,
    structuredContent: 'always',
  });

  const result = await executor.execute('snapshot', {});

  assert.deepEqual(result.structuredContent, snapshotResult);
});
