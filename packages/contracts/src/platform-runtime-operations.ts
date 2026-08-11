import type { AppLogRuntimeHost, AppLogRuntimeOperations } from './app-log-runtime.ts';
import type { NetworkRuntimeHost, NetworkRuntimeOperations } from './network-runtime.ts';
import type { ScreenRecordingRuntimeHost } from './screen-recording-runtime-host.ts';
import type { ScreenRecordingRuntimeOperations } from './screen-recording-runtime.ts';
import {
  runtimeUse,
  type DeviceRuntimeOwner,
  type RuntimeOwnerRef,
  type RuntimePlatformModule,
} from './platform-runtime.ts';

export type PlatformRuntimeOperations = AppLogRuntimeOperations &
  NetworkRuntimeOperations &
  ScreenRecordingRuntimeOperations;

/**
 * The one neutral runtime-use declaration every command domain shares (ADR 0019 §9): no
 * per-domain currying wrappers. Lives here, next to the concrete `PlatformRuntimeOperations`
 * catalog it closes over, so the generic `runtimeUse` primitive in `platform-runtime.ts`
 * never depends on it.
 */
export const defineUse = runtimeUse<PlatformRuntimeOperations>();

export type PlatformRuntimeHost = AppLogRuntimeHost &
  NetworkRuntimeHost &
  Readonly<{ screenRecording: ScreenRecordingRuntimeHost }>;

export type PlatformRuntimeOwner = DeviceRuntimeOwner<PlatformRuntimeOperations>;

export type PlatformRuntimeModule = RuntimePlatformModule<
  PlatformRuntimeOperations,
  PlatformRuntimeHost
>;

/** Cheap exact-owner metadata stays eager; provider mechanics remain lazy until selection. */
export type PlatformRuntimeProviderModule = Readonly<{
  owner: Extract<RuntimeOwnerRef, { kind: 'provider-runtime' }>;
  loadRuntime(host: PlatformRuntimeHost): Promise<PlatformRuntimeOwner>;
}>;
