import type { Lease } from '@agent-device/contracts/client';
import type { CliFlags } from '@agent-device/contracts/command';
import {
  DAEMON_HOST_DEVICE_SHAPE_FEATURE,
  DAEMON_HOST_SERVICE,
} from '@agent-device/contracts/daemon-http';
import { AppError } from '@agent-device/kernel/errors';
import { readRemoteDaemonHealthForFlags } from '../../daemon-client/daemon-client-lifecycle.ts';
import type { RemoteConnectionState } from '../../remote/remote-connection-state.ts';

const HINT = 'Example: open com.example.app --platform ios --device "iPhone 16"';

/**
 * On Host every lease is a fresh device allocated by type (ADR 0021 §5), so `--device` is a type,
 * never a name resolved against inventory, and nothing else selects the device. Returns the lease
 * state to allocate with, or undefined for any endpoint that is not a Host. Every refusal happens
 * here, before a lease is requested (§8).
 */
export async function resolveHostShapeLeaseState(
  state: RemoteConnectionState,
  flags: CliFlags,
): Promise<RemoteConnectionState | undefined> {
  const health = await readRemoteDaemonHealthForFlags(flags);
  if (health?.service !== DAEMON_HOST_SERVICE) return undefined;
  // Only authenticated Host health carries an instance id; the anonymous one is minimal.
  if (!health.instanceId) {
    throw hostShapeError('UNAUTHORIZED', 'The Host did not accept the daemon auth token.', {
      reason: 'host-unauthenticated',
      hint: 'Pass the Host service token with --daemon-auth-token or AGENT_DEVICE_DAEMON_AUTH_TOKEN.',
    });
  }
  if (!health.features?.includes(DAEMON_HOST_DEVICE_SHAPE_FEATURE)) {
    throw hostShapeError('UNSUPPORTED_OPERATION', 'This Host cannot allocate devices by type.', {
      reason: 'host-shape-unsupported',
      hint: 'The Host daemon advertises no device-shape allocation; it needs its lease coordinator.',
    });
  }
  const platform = flags.platform ?? state.platform;
  if (platform !== 'ios' && platform !== 'android') {
    throw hostShapeError('INVALID_ARGS', 'A Host device type needs --platform ios or android.', {
      reason: 'host-shape-platform-required',
      hint: HINT,
    });
  }
  const deviceType = flags.device?.trim();
  if (!deviceType || flags.udid || flags.serial) {
    throw hostShapeError('INVALID_ARGS', 'A Host lease is requested by --device "<type>" only.', {
      reason: 'host-shape-invalid',
      hint: HINT,
    });
  }
  if (state.leaseId && state.hostDeviceType && state.hostDeviceType !== deviceType) {
    throw hostShapeError('INVALID_ARGS', `This session already holds a ${state.hostDeviceType}.`, {
      reason: 'host-shape-mismatch',
      hint: 'Close the session, or use another --session, to get a different device type.',
    });
  }
  return { ...state, platform, hostDeviceType: deviceType, updatedAt: new Date().toISOString() };
}

/** After allocation the command addresses the leased device, not a device that shares its name. */
export function pinLeasedHostDevice(flags: CliFlags, lease: Lease): void {
  const id = lease.deviceKey?.split(':').slice(2).join(':');
  if (!id) return;
  delete flags.device;
  if (flags.platform === 'android') flags.serial = id;
  else flags.udid = id;
}

function hostShapeError(
  code: 'UNAUTHORIZED' | 'UNSUPPORTED_OPERATION' | 'INVALID_ARGS',
  message: string,
  details: Record<string, unknown>,
): AppError {
  return new AppError(code, message, details);
}
