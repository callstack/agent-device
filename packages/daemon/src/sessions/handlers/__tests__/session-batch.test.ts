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

test('a batch runs its steps in order and answers with one entry per step', async () => {
  const invoke = vi.fn(async (req: DaemonRequest) => ({
    ok: true as const,
    data: { step: req.command },
  }));

  const response = await runBatchCommands(batch('wait', 'close'), 'journey', invoke);

  expect(response).toMatchObject({
    ok: true,
    data: {
      results: [
        { command: 'wait', data: { step: 'wait' } },
        { command: 'close', data: { step: 'close' } },
      ],
    },
  });
});

test.each([
  { name: 'close', close: 'close' },
  { name: 'a close spelled differently', close: ' CLOSE ' },
])('a batch with $name closes the session it runs in', async ({ close }) => {
  const invoke = vi.fn(async (_step: DaemonRequest) => ({ ok: true as const, data: {} }));

  await runBatchCommands(batch('wait', close), 'journey', invoke);

  expect(invoke.mock.calls.map(([step]) => step.command)).toEqual(['wait', 'close']);
});

test('malformed steps fail batch validation before any step runs', async () => {
  const invoke = vi.fn(async () => ({ ok: true as const, data: {} }));
  const req = { ...batch('wait'), flags: { batchSteps: 'close' } } as unknown as DaemonRequest;

  await expect(runBatchCommands(req, 'journey', invoke)).resolves.toMatchObject({
    ok: false,
    error: { code: 'INVALID_ARGS' },
  });
  expect(invoke).not.toHaveBeenCalled();
});
