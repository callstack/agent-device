import assert from 'node:assert/strict';
import { test } from 'vitest';
import { findCommandMetadata, type AgentDeviceClient } from '@agent-device/command-surface';
import { createCommandToolExecutor, listCommandTools } from '../command-tools.ts';

const ACCEPTED = 'input accepted';

// Reads the input as the command route does, then stops before any client call.
function createReadingExecutor() {
  return createCommandToolExecutor({
    createClient: () => ({}) as AgentDeviceClient,
    runCommand: async (_client, name, input) => {
      findCommandMetadata(name).readInput(input);
      throw new Error(ACCEPTED);
    },
  });
}

function toolText(result: { content: Array<{ text: string }> }): string {
  return result.content[0]?.text ?? '';
}

function exampleFromHint(text: string, prefix: string): Record<string, unknown> {
  const line = text.split('\n').find((entry) => entry.startsWith(`Hint: ${prefix}`));
  assert.ok(line, `expected a "${prefix}" hint in:\n${text}`);
  return JSON.parse(line.slice(`Hint: ${prefix}`.length)) as Record<string, unknown>;
}

// An agent without the schema loaded guesses the CLI's vocabulary as flat arguments.
test.for([
  ['press', { ref: '@e6' }],
  ['click', { selector: 'id=home/products' }],
  ['click', { ref: '@e6' }],
  ['press', { x: 120, y: 340 }],
  ['fill', { ref: '@e3', text: 'qa@example.com' }],
  ['get', { format: 'text', selector: 'id=title' }],
] as const)('MCP admits the guessed %s call %j', async ([name, input]) => {
  const result = await createReadingExecutor().execute(name, input);
  assert.match(toolText(result), new RegExp(ACCEPTED));
});

test('an unknown argument answers with a call example the tool accepts', async () => {
  const executor = createReadingExecutor();
  const refused = await executor.execute('press', { element: '@e6' });

  assert.equal(refused.isError, true);
  const text = toolText(refused);
  assert.match(text, /element is not an accepted argument for the press tool/);
  const example = exampleFromHint(text, 'Example call: press ');
  assert.deepEqual(example, { ref: '@e12' });
  assert.match(toolText(await executor.execute('press', example)), new RegExp(ACCEPTED));
});

test('every tool hint example is accepted by that tool', async () => {
  const executor = createReadingExecutor();
  for (const { name } of listCommandTools()) {
    const refused = await executor.execute(name, { notAnArgument: true });
    const example = exampleFromHint(toolText(refused), `Example call: ${name} `);
    const retried = toolText(await executor.execute(name, example));
    assert.match(retried, new RegExp(ACCEPTED), `${name} refused ${JSON.stringify(example)}`);
  }
});

test('an unknown argument inside a batch step answers with a step example', async () => {
  const executor = createReadingExecutor();
  const refused = await executor.execute('batch', {
    steps: [{ command: 'click', input: { element: '@e6' } }],
  });

  const text = toolText(refused);
  assert.match(text, /batch\.steps\[0\]\.input: element is not an accepted argument/);
  const step = exampleFromHint(text, 'Example step: ');
  assert.deepEqual(step, { command: 'click', input: { ref: '@e12' } });
  assert.match(toolText(await executor.execute('batch', { steps: [step] })), new RegExp(ACCEPTED));
});

test('the removed nested target reaches its migration guidance over MCP', async () => {
  const result = await createReadingExecutor().execute('press', {
    target: { kind: 'ref', ref: '@e6' },
  });

  assert.equal(result.isError, true);
  assert.match(toolText(result), /target was removed; pass the UI target at the top level/);
  const press = listCommandTools().find((tool) => tool.name === 'press');
  assert.ok(press && !('target' in (press.inputSchema.properties ?? {})));
});
