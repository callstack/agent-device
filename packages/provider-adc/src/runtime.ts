import { setTimeout as delay } from 'node:timers/promises';
import type { ProviderDeviceRuntime } from '@agent-device/contracts/device';
import type { ProviderAndroidHost } from 'agent-device/plugins/device-host';
import type { PlatformRuntimeHost } from '@agent-device/contracts/platform-runtime-operations';
import {
  providerRuntimeOwner,
  providerRuntimeInstance,
} from '@agent-device/contracts/platform-runtime';
import { createAdbProvider } from './adb.ts';
import { matchesPlatformSelector, type DeviceInfo } from '@agent-device/kernel/device';
import { AppError } from '@agent-device/kernel/errors';
import { createProviderLeaseTable } from '@agent-device/provision-kit/provider-lease-table';
import { adcClient, type Credentials } from './client.ts';
import { connectAdb } from './tunnel.ts';
import { formFactor } from './target.ts';

type Handle = { leaseId: string; adcId?: string };
type Session = { device: DeviceInfo; adcId: string };
export function createRegistration(
  config: Credentials,
  env: NodeJS.ProcessEnv,
  android: Pick<
    ProviderAndroidHost,
    'createLeaseInteractor' | 'bindDeployment' | 'getForegroundApp'
  >,
) {
  const client = config.kind === 'direct' ? adcClient(config) : undefined;
  const tunnels = new Map<string, Awaited<ReturnType<typeof connectAdb>>>();
  const deviceLeases = new Map<string, string>();
  const table = createProviderLeaseTable<Session, Handle, boolean>({
    startTimeoutMs: 180_000,
    stopTimeoutMs: 25_000,
    async start(lease, tv, control) {
      const { leaseId } = lease;
      const { signal } = control;
      let access;
      if (config.kind === 'attached') {
        access = config.access;
      } else {
        if (!client) throw new Error('Missing ADC client');
        let record = await client.create(leaseId, tv, signal);
        control.rented({ leaseId, adcId: record.id });
        while (record.status === 'queued') {
          await delay(500, undefined, { signal });
          record = await client.get(record.id, signal);
        }
        if (record.status !== 'active')
          throw new AppError('COMMAND_FAILED', `ADC lease ended with status ${record.status}.`);
        access = await client.access(record.id, signal);
      }
      const handle = { leaseId, adcId: access.leaseId };
      const tunnel = await connectAdb(access, env, signal);
      if (signal.aborted) {
        await tunnel.close();
        signal.throwIfAborted();
      }
      tunnels.set(leaseId, tunnel);
      deviceLeases.set(tunnel.serial, leaseId);
      const device: DeviceInfo = {
        platform: 'android',
        kind: 'device',
        id: tunnel.serial,
        booted: true,
        name: tv ? 'ADC Android TV' : 'ADC Android phone',
        target: tv ? 'tv' : 'mobile',
      };
      return { status: 'ready', session: { device, adcId: access.leaseId }, handle };
    },
    async stop(handle) {
      const tunnel = tunnels.get(handle.leaseId);
      try {
        if (client && handle.adcId) await client.end(handle.adcId);
      } finally {
        if (tunnel) {
          deviceLeases.delete(tunnel.serial);
          await tunnel.close();
          tunnels.delete(handle.leaseId);
        }
      }
    },
    handleKey: (handle) => handle.leaseId,
    async findByLease({ leaseId }) {
      const adcId = await client?.find(leaseId);
      return adcId ? { leaseId, adcId } : { leaseId };
    },
    shuttingDown: () => new AppError('COMMAND_FAILED', 'ADC is shutting down.'),
    releasing: () => new AppError('COMMAND_FAILED', 'ADC lease is being released.'),
    gaveUp: () => new AppError('COMMAND_FAILED', 'ADC allocation was canceled or timed out.'),
    cleanupPending: () => new AppError('COMMAND_FAILED', 'ADC lease cleanup is still pending.'),
  });
  const principal = config.kind === 'direct' ? config.key : config.access.token;
  const origin = config.kind === 'direct' ? config.origin.origin : config.access.url.href;
  const instance = providerRuntimeInstance('adc', [
    ['credential', principal],
    ['endpoint', origin],
  ]);
  function leaseIdFor(device: DeviceInfo) {
    const leaseId = deviceLeases.get(device.id);
    if (!leaseId || !table.live(leaseId))
      throw new AppError('DEVICE_NOT_FOUND', 'ADC lease is closed.');
    return leaseId;
  }
  function adbSocket(device: DeviceInfo) {
    const leaseId = leaseIdFor(device);
    const tunnel = tunnels.get(leaseId);
    if (!tunnel) throw new AppError('DEVICE_NOT_FOUND', 'ADC lease is closed.');
    return tunnel.socketSpec;
  }

  function getAdb(device: DeviceInfo) {
    return createAdbProvider(device.id, () => adbSocket(device), env);
  }
  const owner = providerRuntimeOwner('adc', instance);
  const runtime: ProviderDeviceRuntime = {
    provider: 'adc',
    rentalRecoveryPrincipal: instance,
    leaseLifecycle: {
      async allocate(lease, context) {
        if (lease.leaseProvider !== 'adc' || lease.backend !== 'android-instance') return undefined;
        const tv = formFactor(context?.flags) === 'tv';
        const session = await table.allocate(lease, tv, {
          ...context,
          requireJoinable(previous) {
            if (previous !== tv)
              throw new AppError(
                'INVALID_ARGS',
                'ADC lease already selected a different form factor.',
              );
          },
        });
        return { device: session.device, providerSessionId: session.adcId };
      },
      async release(lease) {
        if (lease.leaseProvider !== 'adc') return undefined;
        try {
          await table.release(lease.leaseId);
          return { release: 'confirmed' };
        } catch (error) {
          return { release: 'unknown', error };
        }
      },
    },
    async recoverExpiredLease(lease) {
      if (lease.leaseProvider === 'adc') await table.recover(lease);
    },
    async deviceInventoryProvider(request) {
      if (request.leaseProvider !== 'adc' || !request.leaseId) return null;
      const live = table.live(request.leaseId);
      return live && matchesPlatformSelector(live.device, request.platform) ? [live.device] : [];
    },
    getInteractor(device) {
      if (!runtime.ownsDevice(device)) return undefined;
      const adb = getAdb(device);
      return android.createLeaseInteractor(device, adb);
    },
    ownsDevice(device) {
      const leaseId = deviceLeases.get(device.id);
      if (!leaseId || device.platform !== 'android') return false;
      return table.live(leaseId)?.device.target === device.target;
    },
    shutdown: () => table.shutdown(),
  };
  return {
    runtime,
    platformModule: {
      owner,
      async loadRuntime(host: PlatformRuntimeHost) {
        const { createPlatformOwner } = await import('./platform.ts');
        return createPlatformOwner(owner, runtime, host, android, getAdb, leaseIdFor);
      },
    },
  };
}
