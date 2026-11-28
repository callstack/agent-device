import { expect, test } from 'vitest';
import { AppError } from '@agent-device/kernel/errors';
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

// A client tells these refusals apart by the typed reason and keys in details,
// never by message text; every assertion below pins that data next to the text.
function refusalOf(fn: () => unknown): AppError {
  try {
    fn();
  } catch (error) {
    if (error instanceof AppError) return error;
    throw error;
  }
  throw new Error('Expected the call to refuse');
}

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
  const refusal = refusalOf(() =>
    readCliBatchStepsJson('[{"command":"press","settle":true,"input":{"ref":"@e1"}}]'),
  );
  expect(refusal.code).toBe('INVALID_ARGS');
  expect(refusal.message).toContain("Pass settle inside the step's input.");
  expect(refusal.details).toMatchObject({
    reason: 'batch_step_misplaced_input_key',
    keys: ['settle'],
  });
  // The shared reader sits inside the family registry's import subtree, so it
  // cannot name the nested command's fields; its refusal carries the shape
  // hint, and no misplaced reason: that reason marks a refusal that names a
  // destination, and this one cannot.
  expectInvalidArgs(
    () =>
      batchMetadata.readInput({
        steps: [{ command: 'press', settle: true, input: { ref: '@e1' } }],
      }),
    'Batch step 1 has unknown field(s): settle.',
  );
  const unplaced = refusalOf(() =>
    batchMetadata.readInput({
      steps: [{ command: 'press', settle: true, input: { ref: '@e1' } }],
    }),
  );
  expect(unplaced.details?.reason).toBeUndefined();
});

test('an undeclared input key is refused with the closest accepted key', () => {
  const refusal = refusalOf(() =>
    readCliBatchStepsJson('[{"command":"press","input":{"ref":"@e1","setle":true}}]'),
  );
  expect(refusal.code).toBe('INVALID_ARGS');
  expect(refusal.message).toContain('Did you mean settle?');
  expect(refusal.details).toMatchObject({
    reason: 'batch_step_unknown_input_key',
    unknownKeys: ['setle'],
    suggestion: 'settle',
  });
});

test('the daemon projection refuses an undeclared step input key before preparation', async () => {
  const writer = createBatchDaemonWriter(async () => {
    throw new Error('prepare must not run for a refused step');
  });
  const refusal = (await writer(
    batchWriterInput([{ command: 'press', input: { ref: '@e1', setle: true } }]),
    host,
  ).then(
    () => {
      throw new Error('Expected the projection to refuse');
    },
    (error: unknown) => error,
  )) as AppError;
  expect(refusal).toBeInstanceOf(AppError);
  expect(refusal.code).toBe('INVALID_ARGS');
  expect(refusal.message).toBe(
    'Batch step 1 input has unknown field(s): setle. Did you mean settle?',
  );
  expect(refusal.details).toMatchObject({
    reason: 'batch_step_unknown_input_key',
    unknownKeys: ['setle'],
    suggestion: 'settle',
  });
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
