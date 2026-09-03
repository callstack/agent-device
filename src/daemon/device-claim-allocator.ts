import type { DeviceInfo } from '@agent-device/kernel/device';
import {
  decodeManagedBindingFence,
  sameRuntimeOwner,
  type DeviceBindingIntent,
  type RuntimeOwnerRef,
} from '@agent-device/contracts/platform-runtime';
import { inspectDeviceClaimFile, type InspectedDeviceClaim } from './device-claim-inspection.ts';
import { canonicalLocalDeviceKey, resolveDeviceClaimPath } from './device-claim-paths.ts';
import { deviceClaimIdentity } from './device-claims.ts';

/**
 * What the allocator-held arm of the device-claim rule found. `binding-invalid`: the binding
 * is not an exact-owner binding of this managed owner under a managed binding fence. `missing`:
 * the store holds no claim for the device. `conflict`: the store holds a claim that is not this
 * installation's allocator-held claim; it is reported and never touched.
 */
export type AllocatorHeldClaimAdmission =
  | Readonly<{ status: 'binding-invalid' }>
  | Readonly<{ status: 'missing' }>
  | Readonly<{ status: 'conflict'; conflict: InspectedDeviceClaim }>;

/**
 * The read-only verifier both claim gates consult for a managed local owner. It never acquires,
 * never locks, and never clears: a managed identity executes only under the allocator-held claim
 * its allocator established, and every record the store can hold today is process-owned.
 */
export function requireAllocatorHeldDeviceClaim(params: {
  device: DeviceInfo;
  owner: RuntimeOwnerRef;
  intent: DeviceBindingIntent;
}): AllocatorHeldClaimAdmission {
  const { device, owner, intent } = params;
  if (
    intent.kind !== 'exact-owner' ||
    !sameRuntimeOwner(intent.owner, owner) ||
    decodeManagedBindingFence(intent.fence) === null
  ) {
    return { status: 'binding-invalid' };
  }
  const deviceKey = canonicalLocalDeviceKey(deviceClaimIdentity(device));
  const existing = inspectDeviceClaimFile(resolveDeviceClaimPath(deviceKey));
  if (!existing) return { status: 'missing' };
  return { status: 'conflict', conflict: existing };
}
