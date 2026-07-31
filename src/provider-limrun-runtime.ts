import type {
  DeviceInventoryProvider,
  LeaseLifecycleProvider,
  ProviderDeviceInstallOptions,
  ProviderDeviceInstallResult,
  ProviderDeviceRuntime,
  ProviderExpiredLeaseRecovery,
  ProviderPortReverseOptions,
} from '@agent-device/contracts/device';
import type { Interactor } from '@agent-device/contracts/interaction';
import type { DeviceInfo } from '@agent-device/kernel/device';
import {
  createLimrunRuntime,
  type LimrunRuntime as LimrunRuntimeImplementation,
  type LimrunRuntimeOptions,
  LIMRUN_PROVIDER,
} from '@agent-device/provider-limrun';
import { createLimrunRuntimeDependencies } from './sdk/limrun-runtime-dependencies.ts';
import type { LimrunDeviceSession } from './sdk/limrun-runtime-types.ts';

export class LimrunRuntime implements ProviderDeviceRuntime {
  private readonly implementation: LimrunRuntimeImplementation;
  // Called through ProviderDeviceRuntime composition and the public Limrun SDK.
  // fallow-ignore-next-line unused-class-member
  readonly provider = LIMRUN_PROVIDER;

  constructor(options: LimrunRuntimeOptions) {
    this.implementation = createLimrunRuntime(options, createLimrunRuntimeDependencies());
  }

  get leaseLifecycle(): LeaseLifecycleProvider {
    return this.implementation.leaseLifecycle;
  }

  get recoverExpiredLease(): ProviderExpiredLeaseRecovery {
    return this.implementation.recoverExpiredLease;
  }

  // Called through ProviderDeviceRuntime composition.
  // fallow-ignore-next-line unused-class-member
  get deviceInventoryProvider(): DeviceInventoryProvider {
    return this.implementation.deviceInventoryProvider;
  }

  // Called through ProviderDeviceRuntime composition and the public Limrun SDK.
  // fallow-ignore-next-line unused-class-member
  ownsDevice(device: DeviceInfo): boolean {
    return this.implementation.ownsDevice(device);
  }

  getInteractor(device: DeviceInfo): Interactor | undefined {
    return this.implementation.getInteractor(device);
  }

  getDeviceSession(device: DeviceInfo): LimrunDeviceSession | undefined {
    return this.implementation.getDeviceSession(device) as LimrunDeviceSession | undefined;
  }

  async installApp(
    device: DeviceInfo,
    app: string,
    appPath: string,
    options?: ProviderDeviceInstallOptions,
  ): Promise<ProviderDeviceInstallResult | undefined> {
    return await this.implementation.installApp?.(device, app, appPath, options);
  }

  // Called through ProviderDeviceRuntime composition and the public Limrun SDK.
  // fallow-ignore-next-line unused-class-member
  async installInstallablePath(
    device: DeviceInfo,
    installablePath: string,
    options?: ProviderDeviceInstallOptions,
  ): Promise<ProviderDeviceInstallResult | undefined> {
    return await this.implementation.installInstallablePath?.(device, installablePath, options);
  }

  async configurePortReverse(
    options: ProviderPortReverseOptions,
  ): Promise<Record<string, unknown> | undefined> {
    return await this.implementation.configurePortReverse?.(options);
  }

  async shutdown(): Promise<void> {
    await this.implementation.shutdown();
  }
}

export type { LimrunRuntimeOptions };
