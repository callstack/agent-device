import { expect, test, vi } from 'vitest';
import type { DaemonRequest } from '../../../core/daemon-request.ts';
import { runBatchCommands } from '../session-batch.ts';

function batch(...commands: string[]): DaemonRequest {
  return {
    token: 't',
    session: 'journey',
    command: 'batch',
    positionals: [],
    flags: { batchSteps: commands.map((command) => ({ command, positionals: [] })) },
  };
}

const refused = {
  ok: false,
  error: expect.objectContaining({
    code: 'INVALID_ARGS',
    details: expect.objectContaining({ reason: 'remote_script_batch_close_unsupported' }),
  }),
};

test.each([
  { name: 'close', close: 'close' },
  { name: 'a close spelled differently', close: ' CLOSE ' },
])('a batch with $name in an armed remote recording runs no step', async ({ close }) => {
  const invoke = vi.fn(async () => ({ ok: true as const, data: {} }));

  await expect(runBatchCommands(batch('wait', close), 'journey', invoke, true)).resolves.toEqual(
    refused,
  );
  expect(invoke).not.toHaveBeenCalled();
});

test.each([
  { name: 'a remote recording batch without close', commands: ['wait'], remote: true },
  {
    name: 'a batch with close outside a remote recording',
    commands: ['wait', 'close'],
    remote: false,
  },
])('$name runs its steps', async ({ commands, remote }) => {
  const invoke = vi.fn(async () => ({ ok: true as const, data: {} }));

  await runBatchCommands(batch(...commands), 'journey', invoke, remote);

  expect(invoke).toHaveBeenCalledTimes(commands.length);
});

test('malformed steps get the batch refusal', async () => {
  const invoke = vi.fn(async () => ({ ok: true as const, data: {} }));
  const req = { ...batch('wait'), flags: { batchSteps: 'close' } } as unknown as DaemonRequest;

  await expect(runBatchCommands(req, 'journey', invoke, true)).resolves.toMatchObject({
    ok: false,
    error: { code: 'INVALID_ARGS' },
  });
});
