import type { EnvMap } from '@agent-device/kernel/source-value';
import type { HarmonyPlatformSelection } from '@agent-device/contracts/platform-plugin';
import type { HostToolchainPreparer } from '@agent-device/contracts/platform-runtime-host';
import { loadAndroidMechanics } from './platform-runtime-android-mechanics.ts';

export function createHostToolchainPreparer(
  env: Readonly<EnvMap>,
  harmony?: HarmonyPlatformSelection,
): HostToolchainPreparer {
  return Object.freeze({
    prepare: async (family) => {
      if (family === 'android') {
        const { ensureAndroidSdkPathConfigured } = await loadAndroidMechanics();
        await ensureAndroidSdkPathConfigured(env);
        return;
      }
      // Only the HarmonyOS plugin reaches this arm: its device discovery and hilog streaming ask
      // the host to prepend the toolchain roots they were configured with. The plugin owns which
      // roots those are; the core hands over the host environment it captured.
      if (family === 'harmonyos') {
        await harmony?.get().operations.prepareToolchain(env);
      }
    },
  });
}
