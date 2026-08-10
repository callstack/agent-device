import type { AppLogRuntimeHost, AppLogRuntimeOperations } from './app-log-runtime.ts';
import type { NetworkRuntimeHost, NetworkRuntimeOperations } from './network-runtime.ts';
import type {
  DeviceRuntimeOwner,
  RuntimeOwnerRef,
  RuntimePlatformModule,
} from './platform-runtime.ts';

export type PlatformRuntimeOperations = AppLogRuntimeOperations & NetworkRuntimeOperations;

export type PlatformRuntimeHost = AppLogRuntimeHost & NetworkRuntimeHost;

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
