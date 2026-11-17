import { expect, test, vi } from 'vitest';
import type { DaemonResponse } from '@agent-device/kernel/contracts';
import type { DaemonRequest } from '../../../core/daemon-request.ts';
import type { ScriptDeliveryLedger } from '../../../core/request-script-delivery-ledger.ts';
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

function ledger(): ScriptDeliveryLedger {
  return { nested: false, versions: new Map(), failures: new Map() };
}

function batchWithLedger(scriptDelivery: ScriptDeliveryLedger, ...commands: string[]) {
  const req = batch(...commands);
  return { req: { ...req, internal: { scriptDelivery } }, scriptDelivery };
}

test.each([
  { name: 'close', close: 'close' },
  { name: 'a close spelled differently', close: ' CLOSE ' },
])('a batch with $name runs its steps (#4595 removed the refusal)', async ({ close }) => {
  const invoke = vi.fn(async () => ({ ok: true as const, data: {} }));

  await expect(runBatchCommands(batch('wait', close), 'journey', invoke)).resolves.toMatchObject({
    ok: true,
  });
  expect(invoke).toHaveBeenCalledTimes(2);
});

test('each executed step runs on the outer request ledger and feeds it', async () => {
  const { req, scriptDelivery } = batchWithLedger(ledger(), 'wait', 'CLOSE');
  const id = '3f2a1b0c-0000-4000-8000-000000000001';
  const invoke = vi.fn(async (step: DaemonRequest) => {
    expect(step.internal?.scriptDelivery).toBe(scriptDelivery);
    return step.command === 'wait'
      ? {
          ok: true as const,
          data: {
            artifacts: [
              {
                field: 'savedScript',
                artifactType: 'session-script',
                artifactId: 'v2',
                scriptPublicationId: id,
                scriptRevision: 2,
              },
            ],
          },
        }
      : { ok: true as const, data: { scriptPublicationId: id } };
  });

  await runBatchCommands(req, 'journey', invoke);

  expect(scriptDelivery.nested).toBe(true);
  expect(scriptDelivery.versions.get(id)?.scriptRevision).toBe(2);
  expect(scriptDelivery.close).toEqual({ publicationId: id, step: 2 });
});

test('a failed step records nothing and the batch keeps its error', async () => {
  const { req, scriptDelivery } = batchWithLedger(ledger(), 'wait', 'close');
  const failure = {
    ok: false as const,
    error: { code: 'COMMAND_FAILED' as const, message: 'tap failed' },
  };
  const invoke = vi.fn(async (step: DaemonRequest): Promise<DaemonResponse> =>
    step.command === 'wait' ? { ok: true, data: {} } : failure,
  );

  await expect(runBatchCommands(req, 'journey', invoke)).resolves.toMatchObject({
    ok: false,
    error: { message: expect.stringContaining('tap failed') },
  });
  expect(scriptDelivery.versions.size).toBe(0);
  expect(scriptDelivery.failures.size).toBe(0);
  expect(scriptDelivery.close).toBeUndefined();
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
