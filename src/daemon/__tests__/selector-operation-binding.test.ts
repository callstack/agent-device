import { expect, test, vi } from 'vitest';
import {
  selectElementTextOperation,
  selectWaitObservationOperations,
} from '../selector-operation-binding.ts';

test('selector operations are projected by presence and retain their exact bindings', async () => {
  const findText = vi.fn(async () => ({ found: true }));
  const findSelector = vi.fn(async () => ({ found: true }));
  const selected = selectWaitObservationOperations({ operations: { findText, findSelector } });

  await expect(selected.findText?.({ text: 'Ready' })).resolves.toEqual({ found: true });
  await expect(
    selected.findSelector?.({ selector: { key: 'id', value: 'ready' } }),
  ).resolves.toEqual({ found: true });
  expect(findText).toHaveBeenCalledOnce();
  expect(findSelector).toHaveBeenCalledOnce();
});

test('selects the admitted element-text operation', async () => {
  const readTextAtPoint = vi.fn(async () => ({ status: 'read' as const, text: 'Ready' }));
  const selected = selectElementTextOperation({ operations: { readTextAtPoint } });

  await expect(selected.readTextAtPoint?.({ point: { x: 1, y: 2 } })).resolves.toMatchObject({
    text: 'Ready',
  });
  expect(readTextAtPoint).toHaveBeenCalledOnce();
});
