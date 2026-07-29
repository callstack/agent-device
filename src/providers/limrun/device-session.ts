import type { Interactor } from '../../contracts/interactor-types.ts';
import type { AppsFilter } from '../../contracts/app-inventory.ts';
import type { DeviceInfo } from '../../kernel/device.ts';
import { AppError } from '../../kernel/errors.ts';
import type { AndroidAdbProvider } from '../../platforms/android/adb-executor.ts';
import type {
  AndroidKeyboardDismissResult,
  AndroidKeyboardState,
} from '../../platforms/android/device-input-state.ts';
import { createLimrunAndroidInteractor, type LimrunAndroidSession } from './android.ts';
import {
  createLimrunIosInteractor,
  installLimrunIosRemoteApp,
  type LimrunIosSession,
} from './ios.ts';

export type LimrunRecordingQuality = 5 | 6 | 7 | 8 | 9 | 10;

export type LimrunInstalledApp = {
  id: string;
  name?: string;
  installType?: string;
};

export type LimrunForegroundApp = {
  appId?: string;
  activity?: string;
};

export type LimrunRemoteInstallOptions = {
  md5?: string;
  relaunch?: boolean;
  appIdentifierHint?: string;
};

export type LimrunRemoteInstallResult = {
  appId?: string;
};

export type LimrunIosCommandResult = {
  code: number;
  stdout: string;
  stderr: string;
};

export type LimrunIosCommandExecution = {
  on(
    event: 'line-stdout' | 'line-stderr',
    listener: (line: string) => void,
  ): LimrunIosCommandExecution;
  on(event: 'exit', listener: (code: number) => void): LimrunIosCommandExecution;
  on(event: 'error', listener: (error: Error) => void): LimrunIosCommandExecution;
  off(
    event: 'line-stdout' | 'line-stderr',
    listener: (line: string) => void,
  ): LimrunIosCommandExecution;
  off(event: 'exit', listener: (code: number) => void): LimrunIosCommandExecution;
  off(event: 'error', listener: (error: Error) => void): LimrunIosCommandExecution;
  wait(): Promise<LimrunIosCommandResult>;
  stop(): void;
};

type LimrunDeviceSessionBase = {
  readonly platform: 'android' | 'ios';
  readonly device: DeviceInfo;
  readonly interactor: Interactor;
  readonly viewport?: { width: number; height: number };
  listApps(filter?: AppsFilter): Promise<LimrunInstalledApp[]>;
  getForegroundApp(): Promise<LimrunForegroundApp | undefined>;
  pressKey(key: string, modifiers?: string[]): Promise<void>;
  readLogs(appId: string | undefined, lineLimit: number): Promise<string>;
  startRecording(options?: { quality?: LimrunRecordingQuality }): Promise<void>;
  stopRecording(options: { outPath: string }): Promise<void>;
  installRemoteApp(
    url: string,
    options?: LimrunRemoteInstallOptions,
  ): Promise<LimrunRemoteInstallResult>;
};

type LimrunRecordingClient = {
  startRecording(options?: { quality?: LimrunRecordingQuality }): Promise<void>;
  stopRecording(options: { localPath: string }): Promise<string>;
};

export type LimrunAndroidDeviceSession = LimrunDeviceSessionBase & {
  readonly platform: 'android';
  readonly adb: AndroidAdbProvider;
  getKeyboardState(): Promise<AndroidKeyboardState>;
  dismissKeyboard(): Promise<AndroidKeyboardDismissResult>;
  removePortReverse(devicePort: number): Promise<void>;
};

export type LimrunIosDeviceSession = LimrunDeviceSessionBase & {
  readonly platform: 'ios';
  runSimctl(args: string[]): LimrunIosCommandExecution;
};

export type LimrunDeviceSession = LimrunAndroidDeviceSession | LimrunIosDeviceSession;

export function createLimrunDeviceSession(
  session: LimrunAndroidSession | LimrunIosSession,
): LimrunDeviceSession {
  return session.platform === 'android'
    ? createAndroidDeviceSession(session)
    : createIosDeviceSession(session);
}

function createAndroidDeviceSession(session: LimrunAndroidSession): LimrunAndroidDeviceSession {
  const adb = session.adbProvider.exec;
  return {
    platform: 'android',
    device: session.device,
    interactor: createLimrunAndroidInteractor(session),
    adb: session.adbProvider,
    listApps: async (filter = 'all') => {
      const { listAndroidAppsWithAdb } = await import('../../platforms/android/app-helpers.ts');
      return (await listAndroidAppsWithAdb(adb, { filter, target: 'mobile' })).map((app) => ({
        id: app.package,
        name: app.name,
      }));
    },
    getForegroundApp: async () => {
      const { getAndroidAppStateWithAdb } = await import('../../platforms/android/app-helpers.ts');
      const app = await getAndroidAppStateWithAdb(adb);
      return app.package ? { appId: app.package, activity: app.activity } : undefined;
    },
    pressKey: async (key, modifiers) => {
      await session.client.pressKey(key, modifiers);
    },
    getKeyboardState: async () => {
      const { getAndroidKeyboardStatusWithAdb } =
        await import('../../platforms/android/device-input-state.ts');
      return await getAndroidKeyboardStatusWithAdb(adb);
    },
    dismissKeyboard: async () => {
      const { dismissAndroidKeyboardWithAdb } =
        await import('../../platforms/android/device-input-state.ts');
      return await dismissAndroidKeyboardWithAdb(adb);
    },
    readLogs: async (_appId, lineLimit) => {
      const { captureAndroidLogcatWithAdb } = await import('../../platforms/android/logcat.ts');
      return await captureAndroidLogcatWithAdb(adb, {
        lines: lineLimit,
        timeoutMs: 5_000,
      });
    },
    ...createRecordingOperations(session.client),
    installRemoteApp: async (url, options) => {
      await session.client.sendAsset(url);
      return { appId: options?.appIdentifierHint };
    },
    removePortReverse: async (devicePort) => {
      await session.adbProvider.reverse?.remove(tcpEndpoint(devicePort));
    },
  };
}

function createIosDeviceSession(session: LimrunIosSession): LimrunIosDeviceSession {
  return {
    platform: 'ios',
    device: session.device,
    interactor: createLimrunIosInteractor(session),
    viewport: {
      width: session.client.deviceInfo.screenWidth,
      height: session.client.deviceInfo.screenHeight,
    },
    listApps: async (filter = 'all') =>
      (await session.client.listApps())
        .filter((app) => filter === 'all' || isUserInstalledIosApp(app))
        .map((app) => ({
          id: app.bundleId,
          name: app.name,
          installType: app.installType,
        }))
        .sort((left, right) => left.id.localeCompare(right.id)),
    getForegroundApp: async () => undefined,
    pressKey: async (key, modifiers) => {
      await session.client.pressKey(key, modifiers);
    },
    readLogs: async (appId, lineLimit) => {
      if (!appId) {
        throw unsupported('logs', 'Limrun iOS app logs require an app bundle identifier.');
      }
      return await session.client.appLogTail(appId, lineLimit);
    },
    ...createRecordingOperations(session.client),
    installRemoteApp: async (url, options) =>
      await installLimrunIosRemoteApp(session, url, options),
    runSimctl: (args) => session.client.simctl(args) as LimrunIosCommandExecution,
  };
}

function createRecordingOperations(client: LimrunRecordingClient) {
  return {
    startRecording: async (options?: { quality?: LimrunRecordingQuality }) => {
      await client.startRecording(options);
    },
    stopRecording: async ({ outPath }: { outPath: string }) => {
      await client.stopRecording({ localPath: outPath });
    },
  };
}

function isUserInstalledIosApp(app: { bundleId: string; installType: string }): boolean {
  return (
    !app.bundleId.startsWith('com.apple.') && !app.installType.toLowerCase().includes('system')
  );
}

function tcpEndpoint(port: number): `tcp:${number}` {
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new AppError('INVALID_ARGS', `Invalid Android tcp reverse port: ${port}`);
  }
  return `tcp:${port}`;
}

function unsupported(command: string, message: string): AppError {
  return new AppError('UNSUPPORTED_OPERATION', message, { command });
}
