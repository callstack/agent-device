import { expect, test, vi } from 'vitest';

const mechanics = vi.hoisted(() => ({ evaluations: 0 }));

vi.mock('./logs/runtime.ts', async (loadOriginal) => {
  mechanics.evaluations += 1;
  return await loadOriginal();
});

import { runtimeModule } from './index.ts';

test('defers Android app-log mechanics until runtime load', async () => {
  expect(mechanics.evaluations).toBe(0);
  expect(runtimeModule.family).toBe('android');
  await runtimeModule.loadRuntime({} as never);
  expect(mechanics.evaluations).toBe(1);
});
