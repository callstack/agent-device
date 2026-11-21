import type {
  DeviceInventoryProvider,
  DeviceLease,
  LeaseLifecycleContext,
  LeaseLifecycleProvider,
  ProviderDeviceRuntime,
} from '@agent-device/contracts/device';
import type { Interactor, RunnerContext } from '@agent-device/contracts/interactor-types';
import type {
  PlatformRuntimeHost,
  PlatformRuntimeProviderModule,
} from '@agent-device/contracts/platform-runtime-operations';
import { providerRuntimeOwner } from '@agent-device/contracts/platform-runtime';
import { AppError } from '@agent-device/kernel/errors';
import type { DeviceInfo } from '@agent-device/kernel/device';
import { verifyVphoneMachine, VPHONE_PROVIDER } from './connection.ts';
import { rejectRefusedProviderProfileFields } from '@agent-device/contracts/provider-profile-fields';
import { VPHONE_PROFILE_FIELDS } from './profile-fields.ts';
import { buildVphoneDevice, isVphoneDeviceId } from './device.ts';
import { createVphoneInteractor } from './interactor.ts';
import { VPHONE_ERROR_REASONS } from './reasons.ts';
import {
  createVphoneTransport,
  type VphoneTransport,
  type VphoneTransportOptions,
} from './transport.ts';

export type VphoneRuntime = ProviderDeviceRuntime & {
  hasLiveSession(device: DeviceInfo): boolean;
};

export type VphoneRuntimeRegistration = Readonly<{
  runtime: VphoneRuntime;
  platformModule: PlatformRuntimeProviderModule;
}>;

type VphoneSession = Readonly<{
  machine: string;
  device: DeviceInfo;
}>;

export function createVphoneRuntime(
  options: VphoneTransportOptions = {},
  transport = createVphoneTransport(options),
): VphoneRuntimeRegistration {
  const runtime = new VphoneRuntimeImplementation(transport);
  return Object.freeze({
    runtime,
    platformModule: Object.freeze({
      owner: providerRuntimeOwner(VPHONE_PROVIDER, VPHONE_PROVIDER),
      loadRuntime: async (host: PlatformRuntimeHost) => {
        const { createVphonePlatformRuntimeOwner } = await import('./platform-runtime.ts');
        return createVphonePlatformRuntimeOwner({ host, runtime });
      },
    }),
  });
}

class VphoneRuntimeImplementation implements VphoneRuntime {
  readonly provider = VPHONE_PROVIDER;
  private readonly sessions = new Map<string, VphoneSession>();
  readonly leaseLifecycle: LeaseLifecycleProvider = {
    allocate: async (lease, context) => await this.allocate(lease, context),
    release: async (lease) => await this.release(lease),
  };
  readonly deviceInventoryProvider: DeviceInventoryProvider = async (request) => {
    const leaseId = request.leaseId;
    if (request.leaseProvider !== this.provider || !leaseId) return null;
    const session = this.sessions.get(leaseId);
    if (!session) return null;
    if (request.platform === undefined || request.platform === 'ios') return [session.device];
    return [];
  };

  private readonly transport: VphoneTransport;

  constructor(transport: VphoneTransport) {
    this.transport = transport;
  }

  ownsDevice(device: DeviceInfo): boolean {
    return this.findSession(device) !== undefined;
  }

  hasLiveSession(device: DeviceInfo): boolean {
    return this.findSession(device) !== undefined;
  }

  getInteractor(device: DeviceInfo, runner?: RunnerContext): Interactor | undefined {
    const session = this.findSession(device);
    return session
      ? createVphoneInteractor({
          transport: this.transport,
          machine: session.machine,
          signal: runner?.signal,
        })
      : undefined;
  }

  async shutdown(): Promise<void> {
    this.sessions.clear();
  }

  private async allocate(lease: DeviceLease, context?: LeaseLifecycleContext) {
    if (lease.leaseProvider !== this.provider) return undefined;
    if (lease.backend !== 'ios-instance') {
      throw new AppError('UNSUPPORTED_PLATFORM', 'vphone leases require the ios-instance backend.');
    }
    rejectRefusedProviderProfileFields(context?.flags, VPHONE_PROFILE_FIELDS);
    const machine = requiredMachine(context);
    const existing = this.sessions.get(lease.leaseId);
    if (existing) {
      if (existing.machine !== machine) {
        throw new AppError('DEVICE_IN_USE', 'A vphone lease cannot change machines.', {
          reason: VPHONE_ERROR_REASONS.leaseMachineMismatch,
        });
      }
      return { vphoneMachine: existing.machine, device: existing.device };
    }
    await verifyVphoneMachine(this.transport, machine, context?.signal);
    const session = { machine, device: buildVphoneDevice(lease, machine) } as const;
    this.sessions.set(lease.leaseId, session);
    return { vphoneMachine: machine, device: session.device };
  }

  private async release(lease: DeviceLease) {
    if (lease.leaseProvider !== this.provider) return undefined;
    const session = this.sessions.get(lease.leaseId);
    this.sessions.delete(lease.leaseId);
    return session ? { vphoneMachine: session.machine } : undefined;
  }

  private findSession(device: DeviceInfo): VphoneSession | undefined {
    if (!isVphoneDeviceId(device.id)) return undefined;
    return [...this.sessions.values()].find((session) => session.device.id === device.id);
  }
}

function requiredMachine(context?: LeaseLifecycleContext): string {
  const value = context?.flags?.device;
  if (typeof value !== 'string' || !value.trim()) {
    throw new AppError(
      'INVALID_ARGS',
      'vphone allocation requires the connected --device machine.',
      {
        reason: VPHONE_ERROR_REASONS.machineMissing,
      },
    );
  }
  return value.trim();
}
