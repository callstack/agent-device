import type { AppStateRuntimeHost, AppStateRuntimeResult } from '@agent-device/contracts/platform';
import type { DeviceInfo } from '@agent-device/kernel/device';

export function createAppStateRuntimeHost(): AppStateRuntimeHost {
  return Object.freeze({
    android: Object.freeze({
      appState: async (device: DeviceInfo, signal: AbortSignal): Promise<AppStateRuntimeResult> => {
        signal.throwIfAborted();
        const { getAndroidAppState } = await import('./platforms/android/app-lifecycle.ts');
        const state = await getAndroidAppState(device);
        signal.throwIfAborted();
        return state;
      },
    }),
    harmonyos: Object.freeze({
      appState: async (device: DeviceInfo, signal: AbortSignal): Promise<AppStateRuntimeResult> => {
        signal.throwIfAborted();
        const { getHarmonyAppState } = await import('./platforms/harmonyos/app-lifecycle.ts');
        const state = await getHarmonyAppState(device);
        signal.throwIfAborted();
        return state;
      },
    }),
  });
}
