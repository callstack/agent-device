import { expect, test, vi } from 'vitest';
import type { DeviceInfo } from '@agent-device/kernel/device';
import { createHarmonyHostStub } from './toolbox.fixtures.ts';

const { pressHarmonyKeyboardKey, snapshotHarmony } = vi.hoisted(() => ({
  pressHarmonyKeyboardKey: vi.fn(async () => undefined),
  snapshotHarmony: vi.fn(async () => ({
    nodes: [{ index: 0, type: 'Button', label: 'Continue' }],
    truncated: false,
  })),
}));

// The interactor imports the owning modules directly, so the test stubs them where they live.
vi.mock('./input-actions.ts', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./input-actions.ts')>()),
  pressHarmonyKeyboardKey,
}));

vi.mock('./snapshot.ts', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./snapshot.ts')>()),
  snapshotHarmony,
}));

import { createHarmonyInteractor } from './interactor.ts';

const device: DeviceInfo = {
  platform: 'harmonyos',
  id: 'emulator',
  name: 'emulator',
  kind: 'emulator',
  booted: true,
};

test('harmonyos snapshot stamps its channel and producer', async () => {
  const { toolbox } = createHarmonyHostStub();
  const result = await createHarmonyInteractor(toolbox, device).snapshot();

  if ('stage' in result) throw new Error('HarmonyOS snapshot must be presented');
  expect(result.backend).toBe('harmonyos-arkui');
  expect(result.producer).toBe('harmonyos-uitest');
  expect(result.nodes).toEqual([{ index: 0, type: 'Button', label: 'Continue' }]);
  expect(snapshotHarmony).toHaveBeenCalledWith(expect.objectContaining({}), device, undefined);
});

test('harmonyos keyboard dismiss invalidates gesture viewport through the Back route', async () => {
  const { toolbox } = createHarmonyHostStub();

  await expect(createHarmonyInteractor(toolbox, device).keyboardDismiss?.()).resolves.toEqual({
    kind: 'acknowledged',
  });

  expect(pressHarmonyKeyboardKey).toHaveBeenCalledWith(
    expect.objectContaining({ runShell: expect.any(Function) }),
    device,
    'Back',
  );
});
