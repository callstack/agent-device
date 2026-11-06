import { createTestIosRunner } from './ios-runner.fixtures.ts';
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
 * The host and platform adapters the runtime tests hand `createLimrunRuntime`: every one of them answers a
 * fixed or a pass-through value, so a case that reaches one of them has left the path it means to drive. The
 * pass-throughs are the ones that shape what they were handed into an invocation or an error, and they shape
 * it the same way every time. A case with a reading of its own spreads this object and replaces the member it
 * drives. The iOS factory binds a shared runtime to the session device and rejects unexpected commands.
 */
export function stubLimrunRuntimeDependencies(): LimrunRuntimeDependencies {
  return {
    clientVersion: 'test-version',
    android: {
      bindDeployment: async () => {
        throw new Error('Unexpected deployment binding');
      },
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
      downloadFile: async () => undefined,
    },
    ios: {
      createAppLogReader: ({ client }) => ({
        readLogs: async (app, limit) => client.appLogTail(app, limit),
        [Symbol.asyncDispose]: async () => {},
      }),
      createRunner: async (session) =>
        createTestIosRunner(() => {
          throw new Error('Unexpected XCTest runner command');
        }, session.device),
      resolveAppAlias: async (app) => app,
      readBundleAppName: async () => undefined,
    },
  };
}
