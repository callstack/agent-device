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

test('a batch that would close an armed remote recording is refused before any step runs', async () => {
  const invoke = vi.fn(async () => ({ ok: true as const, data: {} }));

  await expect(
    runBatchCommands(batch('wait', 'close'), 'journey', invoke, true),
  ).rejects.toMatchObject({
    code: 'INVALID_ARGS',
    details: { reason: 'remote_script_batch_close_unsupported' },
  });
  expect(invoke).not.toHaveBeenCalled();
});

test('a close step spelled differently is refused too', async () => {
  const invoke = vi.fn(async () => ({ ok: true as const, data: {} }));

  await expect(
    runBatchCommands(batch('wait', ' CLOSE '), 'journey', invoke, true),
  ).rejects.toMatchObject({ details: { reason: 'remote_script_batch_close_unsupported' } });
  expect(invoke).not.toHaveBeenCalled();
});

test('malformed steps get the batch refusal, not a type error', async () => {
  const invoke = vi.fn(async () => ({ ok: true as const, data: {} }));
  const req = { ...batch('wait'), flags: { batchSteps: 'close' } } as unknown as DaemonRequest;

  await expect(runBatchCommands(req, 'journey', invoke, true)).resolves.toMatchObject({
    ok: false,
    error: { code: 'INVALID_ARGS' },
  });
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
