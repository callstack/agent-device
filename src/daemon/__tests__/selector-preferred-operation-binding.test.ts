import { expect, test, vi } from 'vitest';
import { selectPreferredSelectorOperations } from '../selector-preferred-operation-binding.ts';

test('preferred selector operations are projected by presence and retain their exact bindings', async () => {
  const findText = vi.fn(async () => ({ found: true }));
  const findSelector = vi.fn(async () => ({ found: true }));
  const selected = selectPreferredSelectorOperations({ operations: { findText, findSelector } });

  expect(selected.readTextAtPoint).toBeUndefined();
  await expect(selected.findText?.({ text: 'Ready' })).resolves.toEqual({ found: true });
  await expect(
    selected.findSelector?.({ selector: { key: 'id', value: 'ready' } }),
  ).resolves.toEqual({ found: true });
  expect(findText).toHaveBeenCalledOnce();
  expect(findSelector).toHaveBeenCalledOnce();
});
