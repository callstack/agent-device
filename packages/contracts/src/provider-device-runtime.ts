import type { DeviceInfo } from '@agent-device/kernel/device';
import type { CloudArtifactProvider } from './cloud-artifacts.ts';
import type {
  DeviceInventoryProvider,
  DeviceLease,
  LeaseLifecycleProvider,
} from './device-provider.ts';
import type { Interactor, RunnerContext } from './interactor-types.ts';

export type ProviderDeviceInstallResult = {
  bundleId?: string;
  packageName?: string;
  appName?: string;
  launchTarget?: string;
};

export type ProviderDeviceInstallOptions = {
  relaunch?: boolean;
  appIdentifierHint?: string;
  packageNameHint?: string;
};

export type ProviderPortReverseOptions = {
  leaseId: string;
  provider?: string;
  devicePort: number;
  hostPort: number;
  name: string;
};

export type ProviderExpiredLeaseRecovery = (lease: DeviceLease) => Promise<void>;

/** Provider adapter contract; root owns active-runtime and request composition. */
export type ProviderDeviceRuntime = {
  provider: string;
  leaseLifecycle: LeaseLifecycleProvider;
  recoverExpiredLease?: ProviderExpiredLeaseRecovery;
  cloudArtifacts?: CloudArtifactProvider;
  deviceInventoryProvider: DeviceInventoryProvider;
  ownsDevice(device: DeviceInfo): boolean;
  getInteractor(device: DeviceInfo, runnerContext?: RunnerContext): Interactor | undefined;
  installApp?(
    device: DeviceInfo,
    app: string,
    appPath: string,
    options?: ProviderDeviceInstallOptions,
  ): Promise<ProviderDeviceInstallResult | undefined>;
  installInstallablePath?(
    device: DeviceInfo,
    installablePath: string,
    options?: ProviderDeviceInstallOptions,
  ): Promise<ProviderDeviceInstallResult | undefined>;
  configurePortReverse?(
    options: ProviderPortReverseOptions,
  ): Promise<Record<string, unknown> | undefined>;
  shutdown(): Promise<void>;
};
