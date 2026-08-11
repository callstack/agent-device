import type { DeviceInfo } from '@agent-device/kernel/device';

/** Neutral foreground identity returned by a selected platform/provider runtime. */
export type AppStateRuntimeResult = Readonly<{
  package?: string;
  activity?: string;
}>;

export type AppStateRuntimeOperations = Readonly<{
  appState(): Promise<AppStateRuntimeResult>;
}>;

export type AppStateRuntimeHost = Readonly<{
  android: Readonly<{
    appState(device: DeviceInfo, signal: AbortSignal): Promise<AppStateRuntimeResult>;
  }>;
  harmonyos: Readonly<{
    appState(device: DeviceInfo, signal: AbortSignal): Promise<AppStateRuntimeResult>;
  }>;
}>;
