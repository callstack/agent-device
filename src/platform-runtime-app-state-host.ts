import type { AppStateRuntimeCommand, AppStateRuntimeHost } from '@agent-device/contracts/platform';
import type { DeviceInfo } from '@agent-device/kernel/device';
import { runAndroidAdb } from './platforms/android/adb.ts';
import { runHarmonyHdc } from './platforms/harmonyos/hdc.ts';

export function createAppStateRuntimeHost(): AppStateRuntimeHost {
  return Object.freeze({
    android: Object.freeze({
      run: async (device: DeviceInfo, command: AppStateRuntimeCommand, signal: AbortSignal) => {
        signal.throwIfAborted();
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
