import { createHash } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import type { LeaseLifecycleContext, ProviderDeviceRuntime } from '@agent-device/contracts/device';
import type { ProviderAndroidHost } from 'agent-device/plugins/device-host';
import type { PlatformRuntimeHost } from '@agent-device/contracts/platform-runtime-operations';
import {
  providerRuntimeOwner,
  providerRuntimeInstance,
} from '@agent-device/contracts/platform-runtime';
import { LEASE_REASONS } from '@agent-device/contracts/lease-scope';
import { createAdbProvider } from './adb.ts';
import { matchesPlatformSelector, type DeviceInfo } from '@agent-device/kernel/device';
import { AppError } from '@agent-device/kernel/errors';
import { createProviderLeaseTable } from '@agent-device/provision-kit/provider-lease-table';
import { adcClient, type Credentials } from './client.ts';
import { connectAdb } from './tunnel.ts';
import { formFactor } from './target.ts';

type Handle = { leaseId: string; adcId?: string };
type Session = { device: DeviceInfo };
type Allocation = { tv: boolean; rental?: LeaseLifecycleContext['rental'] };

function reconciliationKey(leaseId: string) {
  const hash = createHash('sha256');
  hash.update('agent-device:adc:lease:v1\0');
  hash.update(leaseId);
  return hash.digest('hex');
}
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
  let attachedOwner: string | undefined;
  const endedTunnels = new Set<string>();
  const submitted = new Set<string>();
  const table = createProviderLeaseTable<Session, Handle, Allocation>({
    startTimeoutMs: 180_000,
    stopTimeoutMs: 25_000,
    async start(lease, { tv, rental }, control) {
      const { leaseId } = lease;
      const { signal } = control;
      const handle: Handle = { leaseId };
      const key = reconciliationKey(leaseId);
      let access;
      if (config.kind === 'attached') {
        if (attachedOwner !== undefined && attachedOwner !== leaseId)
          throw new AppError('DEVICE_IN_USE', 'This attached ADC lease already has a session.');
        attachedOwner = leaseId;
        control.rented(handle);
        rental?.beforeCreate(key);
        access = config.access;
      } else {
        if (!client) throw new Error('Missing ADC client');
        rental?.beforeCreate(key);
        submitted.add(leaseId);
        let record;
        try {
          record = await client.create(key, tv, signal);
        } catch (error) {
          if (
            error instanceof AppError &&
            [400, 401, 402, 403, 422, 429].includes(Number(error.details?.httpStatus))
          ) {
            submitted.delete(leaseId);
          }
          throw error;
        }
        const id = record.id;
        handle.adcId = id;
        control.rented(handle);
        rental?.rented(id);
        while (record.status === 'queued') {
          await delay(500, undefined, { signal });
          record = await client.get(id, signal);
        }
        if (record.status !== 'active')
          throw new AppError('COMMAND_FAILED', 'The ADC booking is no longer active.');
        access = await client.access(id, signal);
      }
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
      const terminal = () => {
        endedTunnels.add(leaseId);
        void table.release(leaseId).catch(() => {});
      };
      tunnel.closed.addEventListener('abort', terminal, { once: true });
      if (tunnel.closed.aborted) throw new AppError('DEVICE_NOT_FOUND', 'ADC tunnel closed.');
      return { status: 'ready', session: { device }, handle };
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
        if (attachedOwner === handle.leaseId) attachedOwner = undefined;
      }
      submitted.delete(handle.leaseId);
    },
    handleKey: (handle) => handle.leaseId,
    async findByLease({ leaseId }) {
      if (!client || !submitted.has(leaseId)) return { leaseId };
      const key = reconciliationKey(leaseId);
      const adcId = await client.find(key);
      if (!adcId)
        throw new AppError('COMMAND_FAILED', 'ADC has not confirmed the booking outcome.');
      return { leaseId, adcId };
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
  async function reportClosedTunnel(leaseId: string): Promise<never> {
    await table.release(leaseId);
    throw new AppError('COMMAND_FAILED', 'The ADC device connection ended.', {
      reason: LEASE_REASONS.instanceEnded.reason,
    });
  }
  const owner = providerRuntimeOwner('adc', instance);
  const runtime: ProviderDeviceRuntime = {
    provider: 'adc',
    rentalRecoveryPrincipal: instance,
    leaseLifecycle: {
      async allocate(lease, context) {
        if (lease.leaseProvider !== 'adc' || lease.backend !== 'android-instance') return undefined;
        if (endedTunnels.has(lease.leaseId)) return await reportClosedTunnel(lease.leaseId);
        const tv = formFactor(context?.flags) === 'tv';
        const session = await table.allocate(
          lease,
          { tv, rental: context?.rental },
          {
            ...context,
            requireJoinable(previous) {
              if (previous.tv !== tv)
                throw new AppError(
                  'INVALID_ARGS',
                  'ADC lease already selected a different form factor.',
                );
            },
          },
        );
        return { device: session.device };
      },
      async recoverRental(lease, identity, recordInstance) {
        if (lease.leaseProvider !== 'adc') return false;
        if (!client) return true;
        let id = identity.instanceId;
        if (!id) {
          if (!identity.reconciliationKey) return false;
          id = await client.find(identity.reconciliationKey);
          if (!id) return false;
          recordInstance(id);
        }
        await client.end(id);
        return true;
      },
      async heartbeat(lease) {
        if (lease.leaseProvider !== 'adc' || !endedTunnels.has(lease.leaseId)) return undefined;
        return await reportClosedTunnel(lease.leaseId);
      },
      async release(lease) {
        if (lease.leaseProvider !== 'adc') return undefined;
        try {
          await table.release(lease.leaseId);
          endedTunnels.delete(lease.leaseId);
          return { release: 'confirmed' };
        } catch (error) {
          return { release: 'unknown', error };
        }
      },
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
