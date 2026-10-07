import type { CliFlags } from '@agent-device/contracts/command';
import { DAEMON_HOST_DEVICE_SHAPE_FEATURE } from '@agent-device/contracts/daemon-http';
import { AppError } from '@agent-device/kernel/errors';
import { readRemoteDaemonHealthForFlags } from '../../daemon-client/daemon-client-lifecycle.ts';
import type { RemoteConnectionState } from '../../remote/remote-connection-state.ts';

const HOST_SERVICE = 'agent-device-host';

/**
 * On Host, `--device "<type>"` is a shape Host allocates a fresh device for, not a name resolved
 * against inventory (ADR 0021 §5). Returns the lease state to allocate with, or undefined for any
 * endpoint that is not a Host. A Host that cannot allocate by shape is refused here, before any
 * mutation (§8); plain proxy keeps resolving the device as before.
 */
export async function resolveHostShapeLeaseState(
  state: RemoteConnectionState,
  flags: CliFlags,
): Promise<RemoteConnectionState | undefined> {
  if (!requestsDeviceByType(flags)) return undefined;
  const health = await readRemoteDaemonHealthForFlags(flags);
  if (health?.service !== HOST_SERVICE) return undefined;
  if (!health.features?.includes(DAEMON_HOST_DEVICE_SHAPE_FEATURE)) {
    throw new AppError('UNSUPPORTED_OPERATION', 'This Host cannot allocate devices by type.', {
      reason: 'host-shape-unsupported',
      daemonBaseUrl: flags.daemonBaseUrl,
      hint: 'The Host daemon advertises no device-shape allocation; upgrade the Host or start it with its lease coordinator.',
    });
  }
  if (flags.platform !== 'ios' && flags.platform !== 'android') {
    throw new AppError('INVALID_ARGS', 'A Host device type needs --platform ios or android.', {
      reason: 'host-shape-platform-required',
      hint: 'Example: open com.example.app --platform ios --device "iPhone 16"',
    });
  }
  return { ...state, platform: flags.platform, updatedAt: new Date().toISOString() };
}

function requestsDeviceByType(flags: CliFlags): boolean {
  return Boolean(flags.device?.trim()) && !flags.udid && !flags.serial;
}
