import { expect, test, vi } from 'vitest';
import {
  selectElementTextOperation,
  selectWaitObservationOperations,
} from '../selector-operation-binding.ts';

test('selector operations are projected by presence and retain their exact bindings', async () => {
  const findText = vi.fn(async () => ({ found: true }));
  const selected = selectWaitObservationOperations({ operations: { findText } });

  await expect(selected.findText?.({ text: 'Ready' })).resolves.toEqual({ found: true });
  expect(findText).toHaveBeenCalledOnce();
});

test('native observation errors defer to capture regardless of error shape', async () => {
  for (const error of [new Error('runner failed'), { reason: 'AX_UNAVAILABLE' }, undefined]) {
    const selected = selectWaitObservationOperations({
      operations: {
        findText: async () => {
          throw error;
        },
      },
    });
    await expect(selected.findText?.({ text: 'Ready' })).resolves.toEqual({ found: false });
  }
});

test.each(['before', 'success', 'failure'] as const)(
  'native observation preserves cancellation %s dispatch',
  async (timing) => {
    const controller = new AbortController();
    const reason = new Error('request cancelled');
    const findText = vi.fn(async () => {
      controller.abort(reason);
      if (timing === 'failure') throw new Error('runner failed');
      return { found: true };
    });
    if (timing === 'before') controller.abort(reason);
    const selected = selectWaitObservationOperations({ operations: { findText } });
    await expect(selected.findText?.({ text: 'Ready', signal: controller.signal })).rejects.toBe(
      reason,
    );
    expect(findText).toHaveBeenCalledTimes(timing === 'before' ? 0 : 1);
  },
);

test('selects the admitted element-text operation', async () => {
  const readTextAtPoint = vi.fn(async () => ({ status: 'read' as const, text: 'Ready' }));
  const selected = selectElementTextOperation({ operations: { readTextAtPoint } });

  await expect(selected.readTextAtPoint?.({ point: { x: 1, y: 2 } })).resolves.toMatchObject({
    text: 'Ready',
  });
  expect(readTextAtPoint).toHaveBeenCalledOnce();
});
