import type {
  AppStateRuntimeCommand,
  AppStateRuntimeHost,
} from '@agent-device/contracts/app-state-runtime';
import type { DeviceInfo } from '@agent-device/kernel/device';
import { loadAndroidMechanics } from './platform-runtime-android-mechanics.ts';

export function createAppStateRuntimeHost(): AppStateRuntimeHost {
  return Object.freeze({
    android: Object.freeze({
      run: async (device: DeviceInfo, command: AppStateRuntimeCommand, signal: AbortSignal) => {
        signal.throwIfAborted();
        const { runAndroidAdb } = await loadAndroidMechanics();
        const result = await runAndroidAdb(device, [...command.args], {
          allowFailure: command.allowFailure,
          timeoutMs: command.timeoutMs,
          signal,
        });
        signal.throwIfAborted();
        return { stdout: result.stdout };
      },
    }),
    harmonyos: Object.freeze({
      run: async (device: DeviceInfo, command: AppStateRuntimeCommand, signal: AbortSignal) => {
        signal.throwIfAborted();
        const { runHarmonyHdc } = await import('@agent-device/platform-harmonyos');
        const result = await runHarmonyHdc(device, [...command.args], {
          allowFailure: command.allowFailure,
          timeoutMs: command.timeoutMs,
          signal,
        });
        signal.throwIfAborted();
        return { stdout: result.stdout };
      },
    }),
  });
}
