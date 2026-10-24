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
} from '@agent-device/remote/remote-connection-state';
import { AppError, errorMessage } from '@agent-device/kernel/errors';
import {
  deviceSpecUnsupportedError,
  namedLeaseDeviceSpecKeys,
  readLeaseDeviceSpec,
} from '@agent-device/contracts/lease-scope';
import type { LeaseDevice, LeaseDeviceSpec } from '@agent-device/contracts/client';
import type { LeaseBackend } from '@agent-device/kernel/contracts';
import type { CliFlags } from '@agent-device/contracts/command';
import type { AgentDeviceClient, Lease } from '../../agent-device-client.ts';
import { INTERNAL_COMMANDS, PUBLIC_COMMANDS } from '@agent-device/command-registry/catalog';

const proxyLeaseAllocatingCommands: ReadonlySet<string> = new Set([
  PUBLIC_COMMANDS.open,
  PUBLIC_COMMANDS.install,
  PUBLIC_COMMANDS.reinstall,
  PUBLIC_COMMANDS.uninstall,
  INTERNAL_COMMANDS.installSource,
]);

type MaterializedLease = { lease: Lease; acquired: boolean };

export type ResolvedLeaseState = {
  state: RemoteConnectionState;
  /** The allocation names no device; the device comes from the lease the daemon returns. */
  allocateBySpec?: boolean;
};

/**
 * Decides which device a proxy lease is for. A request with an exact identity and no device spec
 * picks the device here and points `flags` at it; any other allocating request is allocated by spec.
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
  // A device spec is only for the backend behind the proxy to read, so the device is never picked
  // here from an inventory that cannot answer it.
  if (hasLeaseDeviceSpec(options.flags)) {
    if (!options.leaseBackend) {
      throw new AppError(
        'INVALID_ARGS',
        `${options.command} with --os, --image-tag or --physical requires --platform or --lease-backend so the proxy backend knows which device family to pick from.`,
      );
    }
    return { state: options.state, allocateBySpec: true };
  }
  // The service behind a proxy may create or choose the device only when it allocates, so without
  // an exact identity the request carries the selectors and the lease names the device.
  if (!options.flags.udid && !options.flags.serial && options.leaseBackend) {
    return { state: options.state, allocateBySpec: true };
  }
  return await resolveProxyLeaseStateLocally(options);
}

function hasLeaseDeviceSpec(flags: CliFlags): boolean {
  return Object.keys(readLeaseDeviceSpec(flags)).length > 0;
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
 *
 * A request that names a device spec has no such fallback: a new lease that does not echo the
 * granted device in `lease.device` came from a backend that ignored the spec, so it is released and
 * the request fails with `device-spec-unsupported`. A renewed lease serves the request only when
 * every spec key the request names equals the one the lease was allocated by. Once a lease is bound,
 * the spec leaves the command flags: the device it chose is named by its identity instead.
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
  const spec = readLeaseDeviceSpec(flags);
  const specKeys = namedLeaseDeviceSpecKeys(spec);
  const leased = parseConnectionDeviceKey(lease.deviceKey);
  if (acquired && specKeys.length > 0 && (!lease.device || !leased)) {
    throw await releaseUnhonouredSpecLease(client, options.state, lease, specKeys);
  }
  if (leased) {
    const identityConflict = leasedIdentityConflict(options.state, flags, leased);
    if (identityConflict && acquired) {
      await releaseLease(client, options.state, lease).catch(() => undefined);
    }
    if (identityConflict) throw identityConflict;
    if (!acquired) {
      assertLeaseSpecMatchesRequest(options.state, lease, spec, leased);
      await assertLeasedDeviceMatchesRequest(client, options.state, flags, leased);
    }
    applyDeviceScopeSelector(flags, leased);
    delete flags.osVersion;
    delete flags.imageTag;
    delete flags.physical;
    return {
      state: {
        ...options.state,
        deviceKey: buildConnectionDeviceKey(leased),
        platform: leased.platform,
        target: options.state.target ?? leased.target,
        ...(acquired
          ? { leaseDeviceSpec: { leaseId: lease.leaseId, spec, device: lease.device } }
          : {}),
      },
      materialized,
    };
  }
  if (!acquired) throw unboundLeaseError(options.state, lease);
  await releaseLease(client, options.state, lease);
  const resolved = await resolveProxyLeaseStateLocally(options);
  return {
    state: resolved.state,
    materialized: await options.allocateByDeviceKey(resolved.state, flags),
  };
}

async function releaseLease(
  client: AgentDeviceClient,
  state: RemoteConnectionState,
  lease: Lease,
): Promise<{ released: boolean }> {
  return await client.leases.release({
    tenant: state.tenant,
    runId: state.runId,
    leaseId: lease.leaseId,
    leaseBackend: lease.backend,
    ...mergeRemoteConnectionRequestMetadata(lease, state),
    deviceKey: lease.deviceKey,
  });
}

/**
 * Releases a new lease whose backend did not confirm the device spec, and returns the refusal. A
 * release that fails is reported in the refusal, which still names the lease, rather than raised in
 * its place: the lease then lapses after its inactivity window.
 */
async function releaseUnhonouredSpecLease(
  client: AgentDeviceClient,
  state: RemoteConnectionState,
  lease: Lease,
  keys: readonly string[],
): Promise<AppError> {
  let release: Record<string, unknown>;
  try {
    release = { released: (await releaseLease(client, state, lease)).released };
  } catch (error) {
    release = { released: false, releaseError: errorMessage(error) };
  }
  return deviceSpecUnsupportedError(
    keys,
    'The proxy backend leased a device without confirming the requested device spec, so the lease was released.',
    { session: state.session, leaseId: lease.leaseId, ...release },
  );
}

/**
 * A renewed lease serves a request only when every spec key the request names equals the one the
 * lease was allocated by. A key the request leaves out keeps the lease's value.
 */
function assertLeaseSpecMatchesRequest(
  state: RemoteConnectionState,
  lease: Lease,
  requested: LeaseDeviceSpec,
  leased: ConnectionDeviceScope,
): void {
  const bound = recordedLeaseDeviceSpec(state, lease.leaseId)?.spec ?? {};
  const conflicting = namedLeaseDeviceSpecKeys(requested).filter(
    (key) => requested[key] !== bound[key],
  );
  if (conflicting.length === 0) return;
  throw new AppError(
    'INVALID_ARGS',
    'Active remote connection is already bound to a device leased by a different device spec. Re-run connect --force to replace it.',
    {
      session: state.session,
      deviceKey: buildConnectionDeviceKey(leased),
      keys: conflicting,
      deviceSpec: bound,
      requestedDeviceSpec: requested,
      reason: 'CONNECTION_DEVICE_CONFLICT',
    },
  );
}

/**
 * A lease serves a request naming `--udid` or `--serial` only when it leases that device; a new
 * lease for another device is released by the caller.
 */
function leasedIdentityConflict(
  state: RemoteConnectionState,
  flags: CliFlags,
  leased: ConnectionDeviceScope,
): AppError | undefined {
  const requested = flags.udid ?? flags.serial;
  if (requested === undefined || requested === leased.id) return undefined;
  return new AppError(
    'INVALID_ARGS',
    'Active remote connection is already bound to a different device. Re-run connect --force to replace it.',
    {
      session: state.session,
      deviceKey: buildConnectionDeviceKey(leased),
      requestedDevice: requested,
      reason: 'CONNECTION_DEVICE_CONFLICT',
    },
  );
}

function recordedLeaseDeviceSpec(
  state: RemoteConnectionState,
  leaseId: string | undefined,
): RemoteConnectionState['leaseDeviceSpec'] {
  return leaseId && state.leaseDeviceSpec?.leaseId === leaseId ? state.leaseDeviceSpec : undefined;
}

/** The device a proxy backend granted for the lease the connection holds now, if it named one. */
export function grantedLeaseDevice(state: RemoteConnectionState): LeaseDevice | undefined {
  return recordedLeaseDeviceSpec(state, state.leaseId)?.device;
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
