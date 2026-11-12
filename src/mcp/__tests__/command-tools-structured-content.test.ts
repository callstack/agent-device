import assert from 'node:assert/strict';
import { test } from 'vitest';
import type { AgentDeviceClient } from '@agent-device/command-surface';
import { AppError } from '@agent-device/kernel/errors';
import { createCommandToolExecutor } from '../command-tools.ts';

const snapshotResult = {
  nodes: [
    { ref: 'e2', type: 'Button', label: 'Save', rect: { x: 1.5, y: 2.5, width: 3, height: 4 } },
  ],
  truncated: false,
};

function executorReturning(
  structuredContent: 'declared' | 'always' | undefined,
  result: (name: string) => unknown = (name) =>
    name === 'snapshot' ? snapshotResult : { message: 'Tapped @e2 (10, 20)' },
) {
  return createCommandToolExecutor({
    createClient: () => ({}) as AgentDeviceClient,
    runCommand: async (_client, name) => result(name) as never,
    ...(structuredContent ? { structuredContent } : {}),
  });
}

test('the default executor returns text only, from typed and untyped tools', async () => {
  const executor = executorReturning(undefined);

  const press = await executor.execute('press', { ref: '@e2' });
  const snapshot = await executor.execute('snapshot', {});
  const json = await executor.execute('snapshot', { mcpOutputFormat: 'json' });

  assert.equal('structuredContent' in press, false);
  assert.equal(press.content[0]?.text, 'Tapped @e2 (10, 20)');
  assert.equal('structuredContent' in snapshot, false);
  assert.match(snapshot.content[0]?.text ?? '', /@e2 \[button\] "Save"/);
  assert.equal('structuredContent' in json, false);
  assert.deepEqual(JSON.parse(json.content[0]?.text ?? ''), snapshotResult);
});

test('the default executor returns a failed call as error text only', async () => {
  const executor = executorReturning(undefined, () => {
    throw new AppError('COMMAND_FAILED', 'snapshot failed');
  });

  const result = await executor.execute('snapshot', {});

  assert.equal(result.isError, true);
  assert.equal('structuredContent' in result, false);
  assert.match(result.content[0]?.text ?? '', /^Error \(COMMAND_FAILED\): snapshot failed/);
});

test('the default executor renders includeCost as JSON text, because the cost rides only on the data', async () => {
  const waitResult = { waitedMs: 42, cost: { wallClockMs: 42, runnerRoundTrips: 0 } };
  const executor = executorReturning(undefined, () => waitResult);

  const result = await executor.execute('wait', { includeCost: true });

  assert.equal('structuredContent' in result, false);
  assert.deepEqual(JSON.parse(result.content[0]?.text ?? ''), waitResult);
});

test('declared returns structuredContent for typed tools, and for untyped tools only on request', async () => {
  const executor = executorReturning('declared');

  const compact = await executor.execute('snapshot', {});
  assert.equal(compact.structuredContent, undefined);
  assert.match(compact.content[0]?.text ?? '', /@e2 \[button\] "Save"/);

  const json = await executor.execute('snapshot', { mcpOutputFormat: 'json' });
  assert.deepEqual(json.structuredContent, snapshotResult);

  const press = await executor.execute('press', { ref: '@e2' });
  assert.deepEqual(press.structuredContent, { message: 'Tapped @e2 (10, 20)' });
});

test('a data host gets structuredContent from untyped tools by default', async () => {
  const executor = executorReturning('always');

  const result = await executor.execute('snapshot', {});

  assert.deepEqual(result.structuredContent, snapshotResult);
});

test.each([
  ['a non-default responseLevel', { responseLevel: 'digest' }],
  ['includeCost', { includeCost: true }],
])('declared returns structuredContent from an untyped tool with %s', async (_case, opt) => {
  const executor = executorReturning('declared', () => ({ path: '/tmp/shot.png' }));

  const result = await executor.execute('screenshot', opt);

  assert.deepEqual(result.structuredContent, { path: '/tmp/shot.png' });
});

test('declared returns a failed untyped tool error in structuredContent', async () => {
  const executor = executorReturning('declared', () => {
    throw new AppError('COMMAND_FAILED', 'snapshot failed');
  });

  const result = await executor.execute('snapshot', {});

  assert.equal(result.isError, true);
  assert.equal((result.structuredContent as { code?: string } | undefined)?.code, 'COMMAND_FAILED');
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

  // Compact: JSON text is what a text-only client shows the model.
  assert.equal(
    result.content[0]?.text,
    '{"nodes":[{"ref":"e1","index":0,"depth":0,"type":"Button","label":"Continue","enabled":true}],"truncated":false}',
  );
});

test('default MCP errors retain possible dispatch, observe-first recovery and the local log path', async () => {
  const executor = executorReturning(undefined, () => {
    const error = new AppError('COMMAND_FAILED', 'press reply was lost', {
      dispatched: 'unknown',
      reason: 'runner_reply_lost',
      logPath: '/tmp/agent-device/press.log',
    });
    throw error;
  });

  const result = await executor.execute('press', { ref: '@e2' });

  assert.equal(result.isError, true);
  assert.equal('structuredContent' in result, false);
  const text = result.content[0]?.text ?? '';
  assert.match(text, /May have reached the device\./);
  assert.match(text, /Run snapshot to check the screen before you retry\./);
  assert.match(text, /Log: \/tmp\/agent-device\/press\.log/);
});
