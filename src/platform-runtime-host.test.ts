import { expect, test, vi } from 'vitest';

const toolchains = vi.hoisted(() => ({
  androidEvaluations: 0,
  androidPrepares: 0,
  harmonyEvaluations: 0,
  harmonyPrepares: 0,
}));

vi.mock('./platforms/android/sdk.ts', () => {
  toolchains.androidEvaluations += 1;
  return {
    ensureAndroidSdkPathConfigured: async () => {
      toolchains.androidPrepares += 1;
    },
  };
});

vi.mock('./platforms/harmonyos/hdc.ts', () => {
  toolchains.harmonyEvaluations += 1;
  return {
    ensureHarmonyToolchainPathConfigured: async () => {
      toolchains.harmonyPrepares += 1;
    },
  };
});

import { createDeviceInventoryHost } from './platform-runtime-host.ts';

test('inventory host loads and prepares only the selected family toolchain', async () => {
  const host = createDeviceInventoryHost();

  expect(toolchains).toEqual({
    androidEvaluations: 0,
    androidPrepares: 0,
    harmonyEvaluations: 0,
    harmonyPrepares: 0,
  });

  await host.toolchains.prepare('android');
  expect(toolchains).toEqual({
    androidEvaluations: 1,
    androidPrepares: 1,
    harmonyEvaluations: 0,
    harmonyPrepares: 0,
  });

  await host.toolchains.prepare('harmonyos');
  expect(toolchains).toEqual({
    androidEvaluations: 1,
    androidPrepares: 1,
    harmonyEvaluations: 1,
    harmonyPrepares: 1,
  });
});
