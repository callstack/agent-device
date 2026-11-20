import { expect, test, vi } from 'vitest';
import type {
  HarmonyPlatformRegistration,
  HarmonyPlatformSelection,
} from '@agent-device/contracts/platform-plugin';

const toolchains = vi.hoisted(() => ({
  androidEvaluations: 0,
  androidPrepares: 0,
  harmonyPrepares: 0,
}));

vi.mock('@agent-device/platform-android/mechanics', () => {
  toolchains.androidEvaluations += 1;
  return {
    ensureAndroidSdkPathConfigured: async () => {
      toolchains.androidPrepares += 1;
    },
  };
});

import { createHostToolchainPreparer } from './platform-runtime-toolchain-host.ts';

/** A selection whose only live member is the toolchain preparation the host arm calls. */
function harmonySelectionFixture(): HarmonyPlatformSelection {
  const active = {
    operations: {
      prepareToolchain: async () => {
        toolchains.harmonyPrepares += 1;
      },
    },
  } as unknown as HarmonyPlatformRegistration;
  return { active, get: () => active };
}

test('toolchain host loads and prepares only the selected family', async () => {
  const host = createHostToolchainPreparer(process.env, harmonySelectionFixture());

  expect(toolchains).toEqual({ androidEvaluations: 0, androidPrepares: 0, harmonyPrepares: 0 });

  await host.prepare('android');
  expect(toolchains).toEqual({ androidEvaluations: 1, androidPrepares: 1, harmonyPrepares: 0 });

  await host.prepare('harmonyos');
  expect(toolchains).toEqual({ androidEvaluations: 1, androidPrepares: 1, harmonyPrepares: 1 });
});

test('toolchain host answers a HarmonyOS request with nothing before the plugin is installed', async () => {
  const host = createHostToolchainPreparer(process.env);
  await expect(host.prepare('harmonyos')).resolves.toBeUndefined();
});
