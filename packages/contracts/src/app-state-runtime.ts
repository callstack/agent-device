import type { DeviceInfo } from '@agent-device/kernel/device';

/** Neutral foreground identity returned by a selected platform/provider runtime. */
export type AppStateRuntimeResult = Readonly<{
  package?: string;
  activity?: string;
}>;

export type AppStateRuntimeCommand = Readonly<{
  args: readonly string[];
  allowFailure?: boolean;
  timeoutMs?: number;
}>;

export type AppStateRuntimeCommandResult = Readonly<{
  stdout: string;
}>;

export type AppStateRuntimeOperations = Readonly<{
  appState(): Promise<AppStateRuntimeResult>;
}>;

export type AppStateRuntimeHost = Readonly<{
  android: Readonly<{
    run(
      device: DeviceInfo,
      command: AppStateRuntimeCommand,
      signal: AbortSignal,
    ): Promise<AppStateRuntimeCommandResult>;
  }>;
  harmonyos: Readonly<{
    run(
      device: DeviceInfo,
      command: AppStateRuntimeCommand,
      signal: AbortSignal,
    ): Promise<AppStateRuntimeCommandResult>;
  }>;
}>;
