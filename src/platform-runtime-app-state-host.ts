import type {
  AppStateRuntimeCommand,
  AppStateRuntimeHost,
} from '@agent-device/contracts/app-state-runtime';
import type { DeviceInfo } from '@agent-device/kernel/device';

export function createAppStateRuntimeHost(): AppStateRuntimeHost {
  return Object.freeze({
    android: Object.freeze({
      run: async (device: DeviceInfo, command: AppStateRuntimeCommand, signal: AbortSignal) => {
        signal.throwIfAborted();
        const { runAndroidAdb } = await import('./platforms/android/adb.ts');
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
        const { runHarmonyHdc } = await import('./platforms/harmonyos/hdc.ts');
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
