import { expect, test } from 'vitest';
import type { DaemonRequest } from '../../../daemon-request.ts';
import { replayInvokeOverDispatch } from '../replay-dispatch-envelope.ts';

test('replayInvokeOverDispatch re-attaches the originating private half, then folds the dispatch bag over it', async () => {
  const base: DaemonRequest = {
    token: 'token',
    session: 'default',
    command: 'replay',
    positionals: [],
    internal: {
      publicNetworkOnly: true,
      replayTargetGuard: {
        identity: { role: 'button', label: 'Old' },
        structural: { documentOrder: 0, sibling: 0 },
      },
    },
  };
  const invoked: DaemonRequest[] = [];
  const invoke = replayInvokeOverDispatch(async (request) => {
    invoked.push(request);
    return { ok: true, data: {} };
  }, base);

  await invoke({
    token: 'token',
    session: 'default',
    command: 'tap',
    positionals: ['@e1'],
    dispatch: {
      replayPlanStep: true,
      replayTargetGuard: {
        identity: { role: 'button', label: 'New' },
        structural: { documentOrder: 1, sibling: 0 },
      },
    },
  });
  await invoke({ token: 'token', session: 'default', command: 'snapshot', positionals: [] });

  expect(invoked[0]?.internal).toEqual({
    publicNetworkOnly: true,
    replayPlanStep: true,
    replayTargetGuard: {
      identity: { role: 'button', label: 'New' },
      structural: { documentOrder: 1, sibling: 0 },
    },
  });
  expect(invoked[0]).not.toHaveProperty('dispatch');
  expect(invoked[1]?.internal).toEqual(base.internal);
});

test('replayInvokeOverDispatch sends no private half when neither side carries one', async () => {
  const invoked: DaemonRequest[] = [];
  const invoke = replayInvokeOverDispatch(
    async (request) => {
      invoked.push(request);
      return { ok: true, data: {} };
    },
    { token: 'token', session: 'default', command: 'replay', positionals: [] },
  );
  await invoke({ token: 'token', session: 'default', command: 'snapshot', positionals: [] });
  expect(invoked[0]).not.toHaveProperty('internal');
});
