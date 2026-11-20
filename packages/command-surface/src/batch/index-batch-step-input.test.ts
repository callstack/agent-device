import { expect, test } from 'vitest';
import type { HostEnvironment } from '@agent-device/kernel/source-value';
import { readCliBatchStepsJson } from './batch-steps.ts';
import { createBatchCommandMetadata } from './metadata.ts';
import { createBatchDaemonWriter } from './projection.ts';
import { screenshotCommandFacet } from '../capture/screenshot.ts';
import type { CommandInput } from '../cli-grammar/types.ts';

const batchMetadata = createBatchCommandMetadata();
const host: HostEnvironment = { env: {}, cwd: '/' };

// The writer seam takes the batch command's own input, whose `steps` flag is
// typed as the CLI's JSON string; the callers that reach it hand over the
// already-parsed step array.
const batchWriterInput = (steps: unknown): CommandInput => ({ steps }) as CommandInput;

function expectInvalidArgs(fn: () => unknown, messageFragment: string) {
  expect(fn).toThrow(
    expect.objectContaining({
      code: 'INVALID_ARGS',
      message: expect.stringContaining(messageFragment),
    }),
  );
}

// The three step-input refusals that used to guide nobody: a screenshot path
// spelled `out` was dropped without a trace, a step field written at the top
// level was refused without its destination, and an unknown input key was
// refused without its closest accepted spelling.
test('a screenshot step accepts out as the structured spelling of path', () => {
  expect(
    readCliBatchStepsJson('[{"command":"screenshot","input":{"out":"/tmp/shot.png"}}]'),
  ).toEqual([{ command: 'screenshot', input: { out: '/tmp/shot.png' } }]);
  expect(screenshotCommandFacet.metadata.readInput({ out: '/tmp/shot.png' })).toMatchObject({
    path: '/tmp/shot.png',
  });
});

test('a step field written at the top level is refused with its destination', () => {
  expectInvalidArgs(
    () => readCliBatchStepsJson('[{"command":"press","settle":true,"input":{"ref":"@e1"}}]'),
    "Pass settle inside the step's input.",
  );
  // The shared reader sits inside the family registry's import subtree, so it
  // cannot name the nested command's fields; its refusal carries the shape
  // hint, which states where input belongs.
  expectInvalidArgs(
    () =>
      batchMetadata.readInput({
        steps: [{ command: 'press', settle: true, input: { ref: '@e1' } }],
      }),
    'Batch step 1 has unknown field(s): settle.',
  );
});

test('an undeclared input key is refused with the closest accepted key', () => {
  expectInvalidArgs(
    () => readCliBatchStepsJson('[{"command":"press","input":{"ref":"@e1","setle":true}}]'),
    'Batch step 1 input has unknown field(s): setle. Did you mean settle?',
  );
});

test('the daemon projection refuses an undeclared step input key before preparation', async () => {
  const writer = createBatchDaemonWriter(async () => {
    throw new Error('prepare must not run for a refused step');
  });
  await expect(
    writer(batchWriterInput([{ command: 'press', input: { ref: '@e1', setle: true } }]), host),
  ).rejects.toThrow(
    expect.objectContaining({
      code: 'INVALID_ARGS',
      message: 'Batch step 1 input has unknown field(s): setle. Did you mean settle?',
    }),
  );
});

test('a declared step input passes projection untouched', async () => {
  const prepared: string[] = [];
  const writer = createBatchDaemonWriter(async (command, input) => {
    prepared.push(`${command}:${JSON.stringify(input)}`);
    return { command, positionals: [], options: {} };
  });
  await expect(
    writer(batchWriterInput([{ command: 'screenshot', input: { out: '/tmp/shot.png' } }]), host),
  ).resolves.toBeDefined();
  expect(prepared).toEqual(['screenshot:{"out":"/tmp/shot.png"}']);
});
