import type { CliFlags } from '@agent-device/contracts/command';
import { INTERNAL_COMMANDS, PUBLIC_COMMANDS } from '@agent-device/command-registry/catalog';
import type { LeaseBackend } from '@agent-device/kernel/contracts';
import {
  deviceFieldsFromPublicPlatform,
  resolveDevice,
  type DeviceInfo,
} from '@agent-device/kernel/device';
import { AppError } from '@agent-device/kernel/errors';
import type { AgentDeviceClient, Lease } from '../../agent-device-client.ts';
import {
  buildConnectionDeviceKey,
  resolveConnectionDeviceScope,
  type RemoteConnectionState,
} from '../../remote/remote-connection-state.ts';

export type ResolvedLeaseState = {
  state: RemoteConnectionState;
  device?: DeviceInfo;
  /** Points the command at the device a lease bound when allocation chose it. */
  pinLeasedDevice?: (flags: CliFlags, lease: Lease) => void;
};

const proxyLeaseAllocatingCommands: ReadonlySet<string> = new Set([
  PUBLIC_COMMANDS.open,
  PUBLIC_COMMANDS.install,
  PUBLIC_COMMANDS.reinstall,
  INTERNAL_COMMANDS.installSource,
]);

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
  const host = await import('./host-device-shape-connection.ts');
  const hostShapeState = await host.resolveHostShapeLeaseState(options.state, options.flags);
  if (hostShapeState) return { state: hostShapeState, pinLeasedDevice: host.pinLeasedHostDevice };
  const device = await resolveSelectedDevice(options.client, options.flags);
  const scope = resolveConnectionDeviceScope(device);
  return {
    state: {
      ...options.state,
      deviceKey: buildConnectionDeviceKey(scope),
      leaseBackend: options.state.leaseBackend ?? options.leaseBackend ?? scope.leaseBackend,
      platform: scope.platform,
      target: options.state.target ?? scope.target,
      updatedAt: new Date().toISOString(),
    },
    device,
  };
}

export function applyResolvedDeviceSelector(flags: CliFlags, device: DeviceInfo): void {
  const scope = resolveConnectionDeviceScope(device);
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
