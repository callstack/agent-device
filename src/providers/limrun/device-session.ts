import type { Interactor } from '@agent-device/contracts/interaction';
import { resolveAppsFilter, type AppsFilter } from '@agent-device/contracts/device';
import type { DeviceInfo } from '@agent-device/kernel/device';
import type {
  LimrunAdbProvider,
  LimrunAndroidKeyboardDismissResult,
  LimrunAndroidKeyboardState,
} from './runtime-dependencies.ts';
import { createLimrunAndroidInteractor, type LimrunAndroidSession } from './android.ts';
import {
  createLimrunIosInteractor,
  installLimrunIosRemoteApp,
  isUserInstalledIosApp,
  type LimrunIosRemoteInstallOptions,
  type LimrunIosRemoteInstallResult,
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
  listApps(filter?: AppsFilter): Promise<LimrunInstalledApp[]>;
  pressKey(key: string, modifiers?: string[]): Promise<void>;
  startRecording(options?: { quality?: LimrunRecordingQuality }): Promise<void>;
  stopRecording(options: { outPath: string }): Promise<string>;
};

type LimrunRecordingClient = {
  startRecording(options?: { quality?: LimrunRecordingQuality }): Promise<void>;
  stopRecording(options: { localPath: string }): Promise<string>;
};

export type LimrunAndroidDeviceSession = LimrunDeviceSessionBase & {
  readonly platform: 'android';
  readonly adb: LimrunAdbProvider;
  getForegroundApp(): Promise<LimrunForegroundApp | undefined>;
  getKeyboardState(): Promise<LimrunAndroidKeyboardState>;
  dismissKeyboard(): Promise<LimrunAndroidKeyboardDismissResult>;
  readLogs(lineLimit: number): Promise<string>;
  installRemoteApp(url: string): Promise<void>;
};

export type LimrunIosDeviceSession = LimrunDeviceSessionBase & {
  readonly platform: 'ios';
  readonly viewport: { width: number; height: number };
  readLogs(appId: string, lineLimit: number): Promise<string>;
  installRemoteApp(
    url: string,
    options?: LimrunIosRemoteInstallOptions,
  ): Promise<LimrunIosRemoteInstallResult>;
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
    listApps: async (filter) =>
      await session.dependencies.android.listApps(adb, resolveAppsFilter(filter)),
    getForegroundApp: async () => await session.dependencies.android.getForegroundApp(adb),
    pressKey: async (key, modifiers) => {
      await session.client.pressKey(key, modifiers);
    },
    getKeyboardState: async () => await session.dependencies.android.getKeyboardState(adb),
    dismissKeyboard: async () => await session.dependencies.android.dismissKeyboard(adb),
    readLogs: async (lineLimit) => await session.dependencies.android.readLogs(adb, lineLimit),
    ...createRecordingOperations(session.client),
    installRemoteApp: async (url) => {
      await session.client.sendAsset(url);
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
    listApps: async (filter) =>
      (await session.client.listApps())
        .filter((app) => resolveAppsFilter(filter) === 'all' || isUserInstalledIosApp(app))
        .map((app) => ({
          id: app.bundleId,
          name: app.name,
          installType: app.installType,
        }))
        .sort((left, right) => left.id.localeCompare(right.id)),
    pressKey: async (key, modifiers) => {
      await session.client.pressKey(key, modifiers);
    },
    readLogs: async (appId, lineLimit) => await session.client.appLogTail(appId, lineLimit),
    ...createRecordingOperations(session.client),
    installRemoteApp: async (url, options) =>
      await installLimrunIosRemoteApp(session, url, options),
    runSimctl: (args): LimrunIosCommandExecution => session.client.simctl(args),
  };
}

function createRecordingOperations(client: LimrunRecordingClient) {
  return {
    startRecording: async (options?: { quality?: LimrunRecordingQuality }) => {
      await client.startRecording(options);
    },
    stopRecording: async ({ outPath }: { outPath: string }) =>
      await client.stopRecording({ localPath: outPath }),
  };
}
