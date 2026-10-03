import { expect, test, vi } from 'vitest';

const mechanics = vi.hoisted(() => ({ evaluations: 0 }));

vi.mock('./logs/runtime.ts', async (loadOriginal) => {
  mechanics.evaluations += 1;
  return await loadOriginal();
});

import { createAndroidRuntimeModule } from './index.ts';

test('defers Android app-log mechanics until runtime load', async () => {
  const runtimeModule = createAndroidRuntimeModule({ bindAdbHost: async () => {} });
  expect(mechanics.evaluations).toBe(0);
  expect(runtimeModule.family).toBe('android');
  await runtimeModule.loadRuntime({} as never);
  expect(mechanics.evaluations).toBe(1);
});

test('binds the adb host it was constructed with before the runtime loads', async () => {
  const order: string[] = [];
  const bindAdbHost = vi.fn(async () => {
    order.push('bind-adb-host');
  });
  const runtimeModule = createAndroidRuntimeModule({ bindAdbHost });

  expect(bindAdbHost).not.toHaveBeenCalled();
  await runtimeModule.loadRuntime({} as never);
  order.push('runtime-loaded');

  expect(order).toEqual(['bind-adb-host', 'runtime-loaded']);
});

test('a binding that fails keeps the runtime unloaded', async () => {
  const runtimeModule = createAndroidRuntimeModule({
    bindAdbHost: async () => {
      throw new Error('adb host unavailable');
    },
  });

  await expect(runtimeModule.loadRuntime({} as never)).rejects.toThrow('adb host unavailable');
});
