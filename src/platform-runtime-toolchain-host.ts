import type { HostToolchainPreparer } from '@agent-device/contracts/platform-runtime-host';
import { loadAndroidMechanics } from './platform-runtime-android-mechanics.ts';

export function createHostToolchainPreparer(): HostToolchainPreparer {
  return Object.freeze({
    prepare: async (family) => {
      if (family === 'android') {
        const { ensureAndroidSdkPathConfigured } = await loadAndroidMechanics();
        await ensureAndroidSdkPathConfigured(process.env);
        return;
      }
      if (family === 'harmonyos') {
        const { ensureHarmonyToolchainPathConfigured } =
          await import('@agent-device/platform-harmonyos');
        await ensureHarmonyToolchainPathConfigured();
      }
    },
  });
}
