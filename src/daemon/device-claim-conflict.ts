import {
  isApplePlatform,
  publicPlatformString,
  type DeviceInfo,
} from '@agent-device/kernel/device';
import { AppError } from '@agent-device/kernel/errors';
import { runtimeOwnerKey, type RuntimeOwnerRef } from '@agent-device/contracts/platform-runtime';
import { shellQuoteIfNeeded } from '@agent-device/host-kit/command';
import type { AllocatorHeldClaimAdmission } from './device-claim-allocator.ts';
import { canonicalLocalDeviceKey } from './device-claim-paths.ts';
import { deviceClaimIdentity } from './device-claims.ts';
import {
  deviceClaimOwnerCannotRelease,
  deviceClaimRequiresStaleInspection,
  type DeviceClaimClassification,
  type InspectedDeviceClaim,
} from './device-claim-inspection.ts';
import type { DaemonResponse } from './types.ts';
import { errorResponse } from './response.ts';

export type DeviceClaimConflictReason =
  | 'DEVICE_CLAIM_LIVE_OWNER'
  | 'DEVICE_CLAIM_RECOVERY_PENDING'
  | 'DEVICE_CLAIM_OWNER_UNCERTAIN';

const DEVICE_CLAIM_CONFLICT_REASONS = new Set<DeviceClaimConflictReason>([
  'DEVICE_CLAIM_LIVE_OWNER',
  'DEVICE_CLAIM_RECOVERY_PENDING',
  'DEVICE_CLAIM_OWNER_UNCERTAIN',
]);

export function isDeviceClaimConflictReason(value: unknown): value is DeviceClaimConflictReason {
  return DEVICE_CLAIM_CONFLICT_REASONS.has(value as DeviceClaimConflictReason);
}

/**
 * The reason of the allocator-held arm's refusal when no allocator-held claim
 * exists. Deliberately not a {@link DeviceClaimConflictReason}: replay retries
 * every conflict reason as infrastructure, and a managed identity that no
 * allocator activated is a permanent condition, not a collision.
 */
export const ALLOCATOR_CLAIM_MISSING = 'allocator-claim-missing';

export function buildDeviceClaimInspectionCommand(
  device: DeviceInfo,
  conflict: Pick<InspectedDeviceClaim, 'claim' | 'classification'>,
  subcommand: 'status' | 'release' = 'status',
): string {
  const publicPlatform = conflict.claim
    ? publicPlatformString({
        platform: conflict.claim.device.family,
        appleOs: conflict.claim.device.appleOs,
      })
    : publicPlatformString(device);
  const selector = isApplePlatform(device.platform) ? '--udid' : '--serial';
  return [
    `agent-device device ${subcommand}`,
    `--platform ${shellQuoteIfNeeded(publicPlatform)}`,
    `${selector} ${shellQuoteIfNeeded(device.id)}`,
    ...(subcommand === 'release' || deviceClaimRequiresStaleInspection(conflict.classification)
      ? ['--stale']
      : []),
  ].join(' ');
}

/**
 * The single construction of the foreign-claim refusal. `open` returns it as a
 * response; the request-scope binding seam throws it, because a
 * `transient-exclusive` command must never receive device operations at all.
 */
export function deviceClaimConflictError(
  device: DeviceInfo,
  conflict: InspectedDeviceClaim,
): AppError {
  const owner = conflict.claim;
  // A provably dead owner has an exact recovery: settle its resources and
  // release the claim. Everything else gets inspection, never a mutation.
  const recoveryCommand = buildDeviceClaimInspectionCommand(
    device,
    conflict,
    deviceClaimOwnerCannotRelease(conflict.classification) ? 'release' : 'status',
  );
  const publicPlatform = owner
    ? publicPlatformString({ platform: owner.device.family, appleOs: owner.device.appleOs })
    : publicPlatformString(device);
  return new AppError(
    'DEVICE_IN_USE',
    owner
      ? `${publicPlatform} device ${device.id} is owned by session "${owner.session}" in workspace "${owner.workspace}".`
      : `${device.name} has an ownership claim that could not be verified.`,
    {
      reason: conflictReason(conflict.classification),
      classification: conflict.classification,
      deviceKey: conflict.deviceKey,
      ...(owner
        ? {
            owner: {
              session: owner.session,
              workspace: owner.workspace,
              stateDir: owner.stateDir,
            },
          }
        : {}),
      recovery: { command: recoveryCommand },
      hint: deviceClaimOwnerCannotRelease(conflict.classification)
        ? `The recorded owner can no longer release this device; settle its resources and release the claim with: ${recoveryCommand}`
        : `Inspect the owner with: ${recoveryCommand}`,
      retriable: false,
    },
  );
}

export function buildDeviceClaimConflictError(
  device: DeviceInfo,
  conflict: InspectedDeviceClaim,
): DaemonResponse {
  return claimRefusalResponse(deviceClaimConflictError(device, conflict));
}

function allocatorClaimMissingError(device: DeviceInfo, owner: RuntimeOwnerRef): AppError {
  return new AppError(
    'COMMAND_FAILED',
    `${publicPlatformString(device)} device ${device.id} is a managed identity with no allocator-held execution claim for this installation.`,
    {
      reason: ALLOCATOR_CLAIM_MISSING,
      owner: runtimeOwnerKey(owner),
      deviceKey: canonicalLocalDeviceKey(deviceClaimIdentity(device)),
      retriable: false,
      hint: 'A managed identity becomes executable only after its allocator activates it and this installation holds its allocator-held claim.',
    },
  );
}

function managedBindingRequiredError(device: DeviceInfo, owner: RuntimeOwnerRef): AppError {
  return new AppError(
    'COMMAND_FAILED',
    'A managed local owner executes only under an exact-owner binding that carries a managed binding fence.',
    {
      reason: 'runtime-contract-invalid',
      owner: runtimeOwnerKey(owner),
      deviceKey: canonicalLocalDeviceKey(deviceClaimIdentity(device)),
      retriable: false,
    },
  );
}

/** What a claim gate does about one verifier outcome. An admission carries no error to throw. */
export type AllocatorHeldAdmissionDecision =
  | Readonly<{ admitted: true }>
  | Readonly<{ admitted: false; error: AppError }>;

/**
 * The single answer both claim gates read. The switch has no default and the return type
 * excludes `undefined`, so an outcome the verifier learns to produce is a compile error here
 * until this function answers it. That is why the decision is a value rather than an optional
 * error: a gate asks whether the outcome was admitted, and an unanswered outcome cannot reach
 * it as silence that reads like an admission.
 */
export function decideAllocatorHeldAdmission(
  device: DeviceInfo,
  owner: RuntimeOwnerRef,
  outcome: AllocatorHeldClaimAdmission,
): AllocatorHeldAdmissionDecision {
  switch (outcome.status) {
    case 'binding-invalid':
      return { admitted: false, error: managedBindingRequiredError(device, owner) };
    case 'missing':
      return { admitted: false, error: allocatorClaimMissingError(device, owner) };
    case 'conflict':
      return { admitted: false, error: deviceClaimConflictError(device, outcome.conflict) };
  }
}

/** `open` returns the allocator-held refusal as a response, exactly as it does the conflict. */
export function buildAllocatorHeldRefusal(
  device: DeviceInfo,
  owner: RuntimeOwnerRef,
  outcome: AllocatorHeldClaimAdmission,
): DaemonResponse | undefined {
  const decision = decideAllocatorHeldAdmission(device, owner, outcome);
  return decision.admitted ? undefined : claimRefusalResponse(decision.error);
}

function claimRefusalResponse(error: AppError): DaemonResponse {
  const { hint, retriable, ...details } = error.details ?? {};
  return errorResponse(error.code, error.message, details, { hint, retriable });
}

function conflictReason(classification: DeviceClaimClassification): DeviceClaimConflictReason {
  switch (classification) {
    case 'live':
      return 'DEVICE_CLAIM_LIVE_OWNER';
    case 'owner-process-dead':
    case 'owner-daemon-superseded':
      return 'DEVICE_CLAIM_RECOVERY_PENDING';
    case 'owner-process-reused':
    case 'owner-state-dir-gone':
    case 'unknown':
    case 'inconsistent':
      return 'DEVICE_CLAIM_OWNER_UNCERTAIN';
  }
}
