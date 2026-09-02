import { expect, test, vi } from 'vitest';
import type { DeviceInfo } from '@agent-device/kernel/device';

const { pressHarmonyKeyboardKey, snapshotHarmony } = vi.hoisted(() => ({
  pressHarmonyKeyboardKey: vi.fn(async () => undefined),
  snapshotHarmony: vi.fn(async () => ({
    nodes: [{ index: 0, type: 'Button', label: 'Continue' }],
    truncated: false,
  })),
}));

vi.mock('@agent-device/platform-harmonyos', () => ({
  appSwitcherHarmony: vi.fn(),
  backHarmony: vi.fn(),
  closeHarmonyApp: vi.fn(),
  doubleClickHarmony: vi.fn(),
  fillHarmony: vi.fn(),
  homeHarmony: vi.fn(),
  longPressHarmony: vi.fn(),
  openHarmonyApp: vi.fn(),
  performHarmonyGesture: vi.fn(),
  pressHarmony: vi.fn(),
  pressHarmonyKeyboardKey,
  readHarmonyGestureViewport: vi.fn(),
  screenshotHarmony: vi.fn(),
  scrollHarmony: vi.fn(),
  setHarmonyOrientation: vi.fn(),
  setHarmonySetting: vi.fn(),
  snapshotHarmony,
  typeHarmony: vi.fn(),
}));

import { createHarmonyInteractor } from '../interactors/harmonyos.ts';

const device: DeviceInfo = {
  platform: 'harmonyos',
  id: 'emulator',
  name: 'emulator',
  kind: 'emulator',
  booted: true,
};

test('harmonyos snapshot stamps its channel and producer', async () => {
  const result = await createHarmonyInteractor(device).snapshot();

  if ('stage' in result) throw new Error('HarmonyOS snapshot must be presented');
  expect(result.backend).toBe('harmonyos-arkui');
  expect(result.producer).toBe('harmonyos-uitest');
  expect(result.nodes).toEqual([{ index: 0, type: 'Button', label: 'Continue' }]);
});

test('harmonyos keyboard dismiss invalidates gesture viewport through the Back route', async () => {
  await expect(createHarmonyInteractor(device).keyboardDismiss?.()).resolves.toEqual({
    kind: 'acknowledged',
  });

  expect(pressHarmonyKeyboardKey).toHaveBeenCalledWith(device, 'Back');
});
