import {
  deviceFieldsFromPublicPlatform,
  matchesDeviceNameSelector,
  resolveDevice,
  type DeviceInfo,
} from '@agent-device/kernel/device';
import {
  buildConnectionDeviceKey,
  mergeRemoteConnectionRequestMetadata,
  parseConnectionDeviceKey,
  resolveConnectionDeviceScope,
  type ConnectionDeviceScope,
  type RemoteConnectionState,
} from '../../remote/remote-connection-state.ts';
import { AppError } from '@agent-device/kernel/errors';
import type { LeaseBackend } from '@agent-device/kernel/contracts';
import type { CliFlags } from '@agent-device/contracts/command';
import type { AgentDeviceClient, Lease } from '../../agent-device-client.ts';
import { INTERNAL_COMMANDS, PUBLIC_COMMANDS } from '@agent-device/command-registry/catalog';

const proxyLeaseAllocatingCommands: ReadonlySet<string> = new Set([
  PUBLIC_COMMANDS.open,
  PUBLIC_COMMANDS.install,
  PUBLIC_COMMANDS.reinstall,
  INTERNAL_COMMANDS.installSource,
]);

type MaterializedLease = { lease: Lease; acquired: boolean };

export type ResolvedLeaseState = {
  state: RemoteConnectionState;
  /** The allocation names no device; the device comes from the lease the daemon returns. */
  allocateBySpec?: boolean;
};

/**
 * Decides which device a proxy lease is for. A request with an exact identity picks the device here
 * and points `flags` at it; any other allocating request is allocated by spec.
 */
export async function resolveProxyLeaseState(options: {
  command: string;
  client: AgentDeviceClient;
  state: RemoteConnectionState;
  flags: CliFlags;
  leaseBackend?: LeaseBackend;
}): Promise<ResolvedLeaseState> {
  if (!proxyLeaseAllocatingCommands.has(options.command)) {
    if (options.state.leaseId && options.state.deviceKey) return { state: options.state };
    throw new AppError(
      'INVALID_ARGS',
      'No active proxy device lease for this session; run open first.',
    );
  }
  // The service behind a proxy may create or choose the device only when it allocates, so without
  // an exact identity the request carries the selectors and the lease names the device.
  if (!options.flags.udid && !options.flags.serial && options.leaseBackend) {
    return { state: options.state, allocateBySpec: true };
  }
  return await resolveProxyLeaseStateLocally(options);
}

async function resolveProxyLeaseStateLocally(options: {
  client: AgentDeviceClient;
  state: RemoteConnectionState;
  flags: CliFlags;
  leaseBackend?: LeaseBackend;
}): Promise<{ state: RemoteConnectionState }> {
  const device = await resolveSelectedDevice(options.client, options.flags);
  const scope = resolveConnectionDeviceScope(device);
  applyDeviceScopeSelector(options.flags, scope);
  return {
    state: {
      ...options.state,
      deviceKey: buildConnectionDeviceKey(scope),
      leaseBackend: options.state.leaseBackend ?? options.leaseBackend ?? scope.leaseBackend,
      platform: scope.platform,
      target: options.state.target ?? scope.target,
      updatedAt: new Date().toISOString(),
    },
  };
}

/**
 * Takes the device from a lease allocated by spec: the one its `deviceKey` names, whether the daemon
 * just picked it or the lease is renewed. A daemon that predates picking leaves the key of a new
 * lease unset, so that lease is released and the device is picked here and allocated by its key, as
 * before. Every lease this client allocates therefore names its device; a renewed lease that names
 * none was supplied from outside, so it is refused and never released.
 */
export async function bindLeaseNamedDevice(options: {
  client: AgentDeviceClient;
  state: RemoteConnectionState;
  flags: CliFlags;
  leaseBackend: LeaseBackend;
  materialized: MaterializedLease;
  allocateByDeviceKey(state: RemoteConnectionState, flags: CliFlags): Promise<MaterializedLease>;
}): Promise<{ state: RemoteConnectionState; materialized: MaterializedLease }> {
  const { client, flags, materialized } = options;
  const { lease, acquired } = materialized;
  const leased = parseConnectionDeviceKey(lease.deviceKey);
  if (leased) {
    if (!acquired) await assertLeasedDeviceMatchesRequest(client, options.state, flags, leased);
    applyDeviceScopeSelector(flags, leased);
    return {
      state: {
        ...options.state,
        deviceKey: buildConnectionDeviceKey(leased),
        platform: leased.platform,
        target: options.state.target ?? leased.target,
      },
      materialized,
    };
  }
  if (!acquired) throw unboundLeaseError(options.state, lease);
  await client.leases.release({
    tenant: options.state.tenant,
    runId: options.state.runId,
    leaseId: lease.leaseId,
    leaseBackend: lease.backend,
    ...mergeRemoteConnectionRequestMetadata(lease, options.state),
    deviceKey: lease.deviceKey,
  });
  const resolved = await resolveProxyLeaseStateLocally(options);
  return {
    state: resolved.state,
    materialized: await options.allocateByDeviceKey(resolved.state, flags),
  };
}

function unboundLeaseError(state: RemoteConnectionState, lease: Lease): AppError {
  return new AppError(
    'UNAUTHORIZED',
    'The active proxy lease names no device this client can use.',
    {
      session: state.session,
      leaseId: lease.leaseId,
      deviceKey: lease.deviceKey,
      reason: 'LEASE_SCOPE_MISMATCH',
      hint: 'Use a lease that names its device, or drop the lease id from the remote config and flags so open allocates one.',
    },
  );
}

/**
 * A renewed lease serves a request only when its device matches every selector the request names.
 * Platform and target are already checked against the connection record; the device name and the
 * simulator-set and allowlist scopes are checked against the daemon's inventory.
 */
async function assertLeasedDeviceMatchesRequest(
  client: AgentDeviceClient,
  state: RemoteConnectionState,
  flags: CliFlags,
  leased: ConnectionDeviceScope,
): Promise<void> {
  const deviceName = flags.device;
  if (!deviceName && !flags.iosSimulatorDeviceSet && !flags.androidDeviceAllowlist) return;
  const devices = await client.devices.list({
    platform: leased.platform,
    target: leased.target,
    iosSimulatorDeviceSet: flags.iosSimulatorDeviceSet,
    androidDeviceAllowlist: flags.androidDeviceAllowlist,
  });
  const matches = devices.some(
    (device) =>
      device.id === leased.id && (!deviceName || matchesDeviceNameSelector(device, deviceName)),
  );
  if (matches) return;
  throw new AppError(
    'INVALID_ARGS',
    'Active remote connection is already bound to a different device. Re-run connect --force to replace it.',
    {
      session: state.session,
      deviceKey: buildConnectionDeviceKey(leased),
      requestedDevice: deviceName,
      reason: 'CONNECTION_DEVICE_CONFLICT',
    },
  );
}

function applyDeviceScopeSelector(flags: CliFlags, scope: ConnectionDeviceScope): void {
  flags.platform = scope.platform;
  flags.target = scope.target ?? flags.target;
  if (scope.identityFlag === 'udid') flags.udid = scope.id;
  if (scope.identityFlag === 'serial') flags.serial = scope.id;
}

async function resolveSelectedDevice(
  client: AgentDeviceClient,
  flags: CliFlags,
): Promise<DeviceInfo> {
  const devices = await client.devices.list({
    platform: flags.platform,
    target: flags.target,
    device: flags.device,
    udid: flags.udid,
    serial: flags.serial,
    iosSimulatorDeviceSet: flags.iosSimulatorDeviceSet,
    androidDeviceAllowlist: flags.androidDeviceAllowlist,
  });
  return await resolveDevice(
    devices.map((device) => ({
      ...deviceFieldsFromPublicPlatform(device.platform),
      id: device.id,
      name: device.name,
      kind: device.kind,
      target: device.target,
      booted: device.booted,
    })),
    {
      platform: flags.platform,
      target: flags.target,
      deviceName: flags.device,
      udid: flags.udid,
      serial: flags.serial,
    },
  );
}
