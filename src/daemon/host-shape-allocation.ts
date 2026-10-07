import type { ManagedShapeRequest } from '@agent-device/contracts/managed-device-allocation';
import { AppError } from '@agent-device/kernel/errors';
import type { DaemonRequest } from './daemon-request.ts';

/**
 * One fresh managed device for one Host lease (ADR 0021 §4, §5). The lease side implements it
 * over Simlock; the daemon calls it before publishing the Host lease that binds the device.
 */
export type HostShapeAllocationRequest = Readonly<{
  /** The principal the Host front-end authenticated; never a value the client chose. */
  principal: string;
  runId: string;
  clientId?: string;
  shape: ManagedShapeRequest;
  ttlMs?: number;
  signal: AbortSignal;
  /** Epoch ms by which `allocate` must settle, from the `lease_allocate` envelope budget. */
  deadline: number;
}>;

export type HostShapeAllocation = Readonly<{ deviceKey: string }>;

export type HostShapeAllocator = Readonly<{
  allocate(request: HostShapeAllocationRequest): Promise<HostShapeAllocation>;
  /** Gives back an allocation whose Host lease could not be published. */
  release(
    request: Readonly<{ principal: string; runId: string; deviceKey: string }>,
  ): Promise<void>;
}>;

/**
 * The shape travels in the device-selection fields `lease_allocate` already carries: `platform`,
 * `device` as the device type, and `providerOsVersion` (`--os-version`). A Host lease is never
 * addressed by a raw inventory identity, so a UDID or serial is refused rather than ignored.
 */
export function readHostShapeRequest(flags: DaemonRequest['flags']): ManagedShapeRequest {
  const platform = flags?.platform;
  const deviceType = typeof flags?.device === 'string' ? flags.device.trim() : '';
  if ((platform !== 'ios' && platform !== 'android') || !deviceType) {
    throw hostShapeInvalid('A Host lease needs --platform ios|android and --device "<type>".');
  }
  if (flags?.udid !== undefined || flags?.serial !== undefined) {
    throw hostShapeInvalid('A Host lease is requested by device type, not by UDID or serial.');
  }
  const osVersion = flags?.providerOsVersion?.trim();
  return { platform, deviceType, ...(osVersion ? { osVersion } : {}) };
}

export function hostShapeAllocationUnavailable(): AppError {
  return new AppError('UNSUPPORTED_OPERATION', 'This daemon has no Host device allocator.', {
    reason: 'host-shape-allocation-unavailable',
    hint: 'Start the daemon with the Host lease coordinator, or connect to a Host that advertises device-shape.',
  });
}

function hostShapeInvalid(message: string): AppError {
  return new AppError('INVALID_ARGS', message, {
    reason: 'host-shape-invalid',
    hint: 'Example: open com.example.app --platform ios --device "iPhone 16" --os-version 18',
  });
}
