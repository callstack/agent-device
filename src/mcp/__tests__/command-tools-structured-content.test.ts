import assert from 'node:assert/strict';
import { test } from 'vitest';
import type { AgentDeviceClient } from '@agent-device/command-surface';
import { AppError } from '@agent-device/kernel/errors';
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

  const press = await executor.execute('press', { ref: '@e2' });
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

test.each([
  ['a non-default responseLevel', { responseLevel: 'digest' }],
  ['includeCost', { includeCost: true }],
])('an untyped tool returns structuredContent with %s', async (_case, opt) => {
  const executor = createCommandToolExecutor({
    createClient: () => ({}) as AgentDeviceClient,
    runCommand: async () => ({ path: '/tmp/shot.png' }),
  });

  const result = await executor.execute('screenshot', opt);

  assert.deepEqual(result.structuredContent, { path: '/tmp/shot.png' });
});

test('a failed untyped tool still returns its error in structuredContent', async () => {
  const executor = createCommandToolExecutor({
    createClient: () => ({}) as AgentDeviceClient,
    runCommand: async () => {
      throw new AppError('COMMAND_FAILED', 'snapshot failed');
    },
  });

  const result = await executor.execute('snapshot', {});

  assert.equal(result.isError, true);
  assert.equal((result.structuredContent as { code?: string } | undefined)?.code, 'COMMAND_FAILED');
});
