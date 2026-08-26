import type { HostToolchainPreparer } from '@agent-device/contracts/platform-runtime-host';

export function createHostToolchainPreparer(): HostToolchainPreparer {
  return Object.freeze({
    prepare: async (family) => {
      if (family === 'android') {
        const { ensureAndroidSdkPathConfigured } = await import('./platforms/android/sdk.ts');
        await ensureAndroidSdkPathConfigured();
        return;
      }
      if (family === 'harmonyos') {
        const { ensureHarmonyToolchainPathConfigured } =
          await import('./platforms/harmonyos/hdc.ts');
        await ensureHarmonyToolchainPathConfigured();
      }
    },
  });
}
