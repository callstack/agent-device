import fs from 'node:fs';
import path from 'node:path';
import type { DeviceInfo } from '@agent-device/kernel/device';
import {
  decodeManagedBindingFence,
  sameRuntimeOwner,
  type DeviceBindingIntent,
  type RuntimeOwnerRef,
} from '@agent-device/contracts/platform-runtime';
import { emitDiagnostic } from '@agent-device/host-kit/diagnostics';
import {
  inspectDeviceClaimFile,
  readAllocatorHeldClaimFile,
  type InspectedDeviceClaim,
} from './device-claim-inspection.ts';
import { canonicalLocalDeviceKey, resolveDeviceClaimPath } from './device-claim-paths.ts';
import {
  allocatorHeldClaimOwner,
  ALLOCATOR_HELD_CLAIM_SCHEMA_VERSION,
  type AllocatorHeldDeviceClaim,
} from './device-claim-record.ts';
import { withDeviceClaimLock, writeDeviceClaim } from './device-claim-store.ts';
import { deviceClaimIdentity, emitClaimConflict } from './device-claims.ts';

/**
 * The full principal of an allocator-held claim: one installation's state dir, the allocator
 * instance that issued the grant, and the identity incarnation it issued it for. Every field is
 * matched exactly — a claim reattaches to the same installation and the same incarnation, or not
 * at all.
 */
export type AllocatorHeldClaimPrincipal = Readonly<{
  stateDir: string;
  instanceId: string;
  identityIncarnationId: string;
}>;

/**
 * What the allocator-held arm of the device-claim rule found. `binding-invalid`: the binding
 * is not an exact-owner binding of this managed owner under a managed binding fence. `missing`:
 * the store holds no claim for the device. `covered`: this installation's allocator-held claim
 * holds the device for the incarnation the binding fences, so the command executes under it.
 * `incarnation-stale`: the claim is ours but holds a different incarnation — the identity was
 * re-provisioned and the grant is no longer valid. `conflict`: the store holds a claim that is not
 * this installation's allocator-held claim; it is reported and never touched.
 */
export type AllocatorHeldClaimAdmission =
  | Readonly<{ status: 'binding-invalid' }>
  | Readonly<{ status: 'missing' }>
  | Readonly<{ status: 'covered' }>
  | Readonly<{ status: 'incarnation-stale'; heldIncarnationId: string }>
  | Readonly<{ status: 'conflict'; conflict: InspectedDeviceClaim }>;

/**
 * The read-only verifier both claim gates consult for a managed local owner. It never acquires,
 * never locks and never clears: a managed identity executes only under the allocator-held claim its
 * allocator established, and only `releaseAllocatorHeldClaim` can ever remove one.
 */
export function requireAllocatorHeldDeviceClaim(params: {
  device: DeviceInfo;
  owner: RuntimeOwnerRef;
  stateDir: string;
  intent: DeviceBindingIntent;
}): AllocatorHeldClaimAdmission {
  const { device, owner, stateDir, intent } = params;
  const binding =
    intent.kind === 'exact-owner' && sameRuntimeOwner(intent.owner, owner)
      ? decodeManagedBindingFence(intent.fence)
      : null;
  if (!binding) return { status: 'binding-invalid' };
  const deviceKey = canonicalLocalDeviceKey(deviceClaimIdentity(device));
  const existing = inspectDeviceClaimFile(resolveDeviceClaimPath(deviceKey));
  if (!existing) return { status: 'missing' };
  const held = existing.allocatorClaim;
  if (
    !held ||
    !sameInstallation(held.stateDir, stateDir) ||
    !sameRuntimeOwner(allocatorHeldClaimOwner(held), owner)
  ) {
    return { status: 'conflict', conflict: existing };
  }
  return held.allocator.identityIncarnationId === binding.identityIncarnationId
    ? { status: 'covered' }
    : { status: 'incarnation-stale', heldIncarnationId: held.allocator.identityIncarnationId };
}

/**
 * The allocator-held claim on this device, for the ordinary arm of the claim gates: an ordinary
 * owner may not execute against a managed identity at all, whoever holds it. Every device binding
 * asks this, so it reads the record and stops — no owner-liveness probe.
 */
export function inspectAllocatorHeldDeviceClaim(device: DeviceInfo): InspectedDeviceClaim | null {
  const deviceKey = canonicalLocalDeviceKey(deviceClaimIdentity(device));
  return readAllocatorHeldClaimFile(resolveDeviceClaimPath(deviceKey));
}

/** What {@link acquireAllocatorHeldDeviceClaim} did with the store. */
export type AllocatorHeldClaimAcquireResult =
  | Readonly<{ status: 'acquired' }>
  | Readonly<{ status: 'reattached' }>
  | Readonly<{ status: 'conflict'; conflict: InspectedDeviceClaim }>;

/**
 * Establishes the execution claim of one allocator-managed identity, or reattaches the claim this
 * installation already holds for it after a daemon restart. It never reconciles, supersedes or
 * abandons: a conflicting ordinary claim prevents publication (ADR 0021 §4), and stale ordinary
 * recovery stays with `device release --stale` and the startup sweep.
 */
// Production caller: the allocator activation unit; the foundations ship the claim kind first.
export async function acquireAllocatorHeldDeviceClaim(params: {
  device: DeviceInfo;
  principal: AllocatorHeldClaimPrincipal;
}): Promise<AllocatorHeldClaimAcquireResult> {
  const { device, principal } = params;
  const identity = deviceClaimIdentity(device);
  const deviceKey = canonicalLocalDeviceKey(identity);
  return await withDeviceClaimLock(deviceKey, async () => {
    const existing = inspectDeviceClaimFile(resolveDeviceClaimPath(deviceKey));
    const held = existing?.allocatorClaim;
    if (existing && !(held && samePrincipal(held, principal))) {
      emitClaimConflict(deviceKey, existing);
      return { status: 'conflict', conflict: existing };
    }
    const now = Date.now();
    writeDeviceClaim({
      schemaVersion: ALLOCATOR_HELD_CLAIM_SCHEMA_VERSION,
      kind: 'allocator',
      deviceKey,
      device: { ...identity, name: device.name },
      stateDir: principal.stateDir,
      allocator: {
        instanceId: principal.instanceId,
        identityIncarnationId: principal.identityIncarnationId,
      },
      createdAtMs: held?.createdAtMs ?? now,
      updatedAtMs: now,
    });
    return { status: held ? 'reattached' : 'acquired' };
  });
}

/**
 * The only path that clears an allocator-held claim, and only against the allocator's proof that it
 * removed exactly that identity incarnation. A process-owned claim, another installation's claim,
 * or a claim of a later incarnation is left byte-identical.
 */
// Production caller: the allocator removal-acknowledgement unit; the foundations ship the claim
// kind first.
export async function releaseAllocatorHeldClaim(params: {
  device: DeviceInfo;
  removalProof: AllocatorHeldClaimPrincipal;
}): Promise<'released' | 'absent' | 'ownership-changed'> {
  const { device, removalProof } = params;
  const deviceKey = canonicalLocalDeviceKey(deviceClaimIdentity(device));
  return await withDeviceClaimLock(deviceKey, async () => {
    const claimPath = resolveDeviceClaimPath(deviceKey);
    const existing = inspectDeviceClaimFile(claimPath);
    if (!existing) return 'absent';
    const held = existing.allocatorClaim;
    if (!held || !samePrincipal(held, removalProof)) return 'ownership-changed';
    try {
      fs.unlinkSync(claimPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      return 'absent';
    }
    emitDiagnostic({
      level: 'info',
      phase: 'device_claim_allocator_released',
      data: {
        deviceKey,
        ownerStateDir: held.stateDir,
        allocatorInstanceId: held.allocator.instanceId,
        identityIncarnationId: held.allocator.identityIncarnationId,
      },
    });
    return 'released';
  });
}

function samePrincipal(
  claim: AllocatorHeldDeviceClaim,
  principal: AllocatorHeldClaimPrincipal,
): boolean {
  return (
    sameInstallation(claim.stateDir, principal.stateDir) &&
    claim.allocator.instanceId === principal.instanceId &&
    claim.allocator.identityIncarnationId === principal.identityIncarnationId
  );
}

function sameInstallation(recorded: string, expected: string): boolean {
  return path.resolve(recorded) === path.resolve(expected);
}
