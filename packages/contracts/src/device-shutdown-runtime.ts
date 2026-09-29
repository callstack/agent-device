import type { DeviceInfo } from '@agent-device/kernel/device';
import type { AppleToolHost, HostCommandRunner } from './platform-runtime-host.ts';
import type { TargetShutdownResult } from './target-shutdown-contract.ts';

export type DeviceShutdownRuntimeOperations = Readonly<{
  shutdownTarget(): Promise<TargetShutdownResult>;
}>;

/** Complete legacy-close adapter; it shares the family capabilities below without binding a facet. */
export type DeviceShutdownCloseCapability = Readonly<{
  canShutdownTarget(device: DeviceInfo): Promise<boolean>;
  shutdownTarget(device: DeviceInfo): Promise<TargetShutdownResult>;
}>;

/** Focused host ports needed by the package-owned shutdown mechanics. */
export type DeviceShutdownRuntimeDependencies = Readonly<{
  appleTools: AppleToolHost;
  commands: HostCommandRunner;
}>;

export type DeviceShutdownFamilyRuntime = Readonly<{
  canShutdownTarget(device: DeviceInfo): boolean;
  shutdownTarget(device: DeviceInfo, signal: AbortSignal): Promise<TargetShutdownResult>;
}>;

export type DeviceShutdownRuntimeLoaders = Readonly<{
  apple: (
    dependencies: Pick<DeviceShutdownRuntimeDependencies, 'appleTools'>,
  ) => Promise<DeviceShutdownFamilyRuntime>;
  android: (
    dependencies: Pick<DeviceShutdownRuntimeDependencies, 'commands'>,
  ) => Promise<DeviceShutdownFamilyRuntime>;
}>;

export type DeviceShutdownRuntimeHost = Readonly<{
  apple: Readonly<{
    shutdownTarget(device: DeviceInfo, signal: AbortSignal): Promise<TargetShutdownResult>;
  }>;
  android: Readonly<{
    shutdownTarget(device: DeviceInfo, signal: AbortSignal): Promise<TargetShutdownResult>;
  }>;
  close?: DeviceShutdownCloseCapability;
}>;
