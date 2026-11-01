import type { AppsFilter } from '@agent-device/contracts/device';
import type { Interactor } from '@agent-device/contracts/interactor-types';
import { AppError } from '@agent-device/kernel/errors';
import {
  androidAdbHostTarget,
  androidAdbInvocation,
  androidAdbSerialTarget,
} from '@agent-device/platform-android/mechanics';
import type { LimrunAdbExecutor, LimrunRuntimeDependencies } from './runtime-dependencies.ts';

/** What no case here exercises: the keyboard is never visible and nothing owns input. */
const NO_KEYBOARD = Object.freeze({
  visible: false as const,
  inputOwner: 'unknown' as const,
});

/**
 * The host and platform adapters the runtime tests hand `createLimrunRuntime`: every one of them answers
 * a fixed value, so a case that reaches one of them has left the path it means to drive. A case with a
 * reading of its own spreads this object and replaces the member it drives.
 */
export function stubLimrunRuntimeDependencies(): LimrunRuntimeDependencies {
  return {
    clientVersion: 'test-version',
    android: {
      createInteractor: () => ({}) as Interactor,
      createPortReverse: async () => ({
        ensure: async () => {},
        remove: async () => {},
        removeAllOwned: async () => {},
        list: async () => [],
      }),
      inferAppName: async () => 'Example',
      listApps: async (_adb: LimrunAdbExecutor, _filter: AppsFilter) => [],
      getForegroundApp: async () => undefined,
      getKeyboardState: async () => ({ ...NO_KEYBOARD }),
      dismissKeyboard: async () => ({
        ...NO_KEYBOARD,
        attempts: 0,
        wasVisible: false,
        dismissed: false,
      }),
      readLogs: async () => '',
      forceStopApp: async () => {},
      deviceAdbInvocation: (serial, command) =>
        androidAdbInvocation(androidAdbSerialTarget(serial), command),
      hostAdbInvocation: (command) => androidAdbInvocation(androidAdbHostTarget(), command),
      adbError: async (message) => new AppError('COMMAND_FAILED', message),
    },
    host: {
      runAdb: async () => ({ stdout: '', stderr: '', exitCode: 0 }),
      archiveDirectory: async () => undefined,
      downloadFile: async () => undefined,
    },
    ios: {
      applySimctlSetting: async () => undefined,
      resolveAppAlias: async (app) => app,
      readBundleAppName: async () => undefined,
    },
  };
}
