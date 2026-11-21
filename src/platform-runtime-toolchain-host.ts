import type { EnvMap } from '@agent-device/kernel/source-value';
import type { HostToolchainPreparer } from '@agent-device/contracts/platform-runtime-host';
import { loadAndroidMechanics } from './platform-runtime-android-mechanics.ts';

/**
 * Prepares the toolchains the core still names. The HarmonyOS plugin needs no arm here: it runs
 * every HDC command through the host it was set up with, with its documented SDK roots already on
 * `PATH`, so nothing in the core has to know that family's toolchain configuration.
 */
export function createHostToolchainPreparer(env: Readonly<EnvMap>): HostToolchainPreparer {
  return Object.freeze({
    prepare: async (family) => {
      if (family === 'android') {
        const { ensureAndroidSdkPathConfigured } = await loadAndroidMechanics();
        await ensureAndroidSdkPathConfigured(env);
      }
    },
  });
}
