import { expect, test, vi } from 'vitest';

const toolchains = vi.hoisted(() => ({
  androidEvaluations: 0,
  androidPrepares: 0,
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

test('the toolchain host loads and prepares the android mechanics once', async () => {
  const host = createHostToolchainPreparer(process.env);

  expect(toolchains).toEqual({ androidEvaluations: 0, androidPrepares: 0 });

  await host.prepare('android');
  await host.prepare('android');
  expect(toolchains).toEqual({ androidEvaluations: 1, androidPrepares: 2 });
});

test('the toolchain host answers every other family with nothing', async () => {
  // HarmonyOS owns its toolchain: the plugin runs HDC on its setup host with its documented roots
  // on PATH, so the core must not load the android mechanics for a HarmonyOS request.
  const before = { ...toolchains };
  const host = createHostToolchainPreparer(process.env);

  await expect(host.prepare('harmonyos')).resolves.toBeUndefined();
  await expect(host.prepare('web')).resolves.toBeUndefined();
  expect(toolchains).toEqual(before);
});
