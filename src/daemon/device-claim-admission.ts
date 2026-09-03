import type { DeviceInfo } from '@agent-device/kernel/device';
import type {
  DeviceBindingIntent,
  RuntimeOwnerRef,
} from '@agent-device/contracts/platform-runtime';
import type { DeviceClaimPolicy } from '../core/command-descriptor/types.ts';
import { emitDiagnostic } from '@agent-device/host-kit/diagnostics';
import { requireAllocatorHeldDeviceClaim } from './device-claim-allocator.ts';
import { allocatorHeldAdmissionError, deviceClaimConflictError } from './device-claim-conflict.ts';
import { deviceClaimRuleForOwner } from './device-claim-rule.ts';
import {
  acquireTransientDeviceClaim,
  clearDeviceClaim,
  type DeviceClaimReconciler,
  type DeviceClaimSessionOwnership,
} from './device-claims.ts';

/**
 * The #1320 claim gate a request passes on its way from a device binding to
 * device operations. The device-claim rule of the admitted owner decides what
 * happens here, under every policy: an ordinary owner takes a transient claim
 * only when the executing command's declared {@link DeviceClaimPolicy} is
 * `transient-exclusive`; a managed local owner is verified against its
 * allocator-held claim; a provider owner takes nothing. There is no other way
 * to obtain device operations, so none of it can be forgotten by a handler.
 *
 * `admit` is called once per device binding by the request runtime bindings,
 * which is where per-device deduplication already lives, with the binding
 * intent the gateway bound.
 */
export type DeviceClaimAdmission = AsyncDisposable &
  Readonly<{
    /**
     * Throws `DEVICE_IN_USE` when a foreign live claim owns the device and
     * `COMMAND_FAILED` when a managed local owner has no allocator-held claim.
     */
    admit(device: DeviceInfo, owner: RuntimeOwnerRef, intent: DeviceBindingIntent): Promise<void>;
  }>;

export function createDeviceClaimAdmission(params: {
  policy: DeviceClaimPolicy;
  command: string;
  workspace: string;
  stateDir: string;
  reconcileOrphanedDeviceClaim: DeviceClaimReconciler;
}): DeviceClaimAdmission {
  // The caller admits once per device binding, so this only has to remember what
  // it took in order to give it back.
  const acquired: DeviceClaimSessionOwnership[] = [];

  return {
    admit: async (device, owner, intent) => {
      switch (deviceClaimRuleForOwner(owner)) {
        case 'none':
          return;
        case 'allocator-held': {
          const error = allocatorHeldAdmissionError(
            device,
            owner,
            requireAllocatorHeldDeviceClaim({ device, owner, intent }),
          );
          if (error) throw error;
          return;
        }
        case 'ordinary': {
          // `none`/`observe`/`require-owner` never read or write the claim store,
          // and `acquire-session`/`release-session` own the session claim through
          // the open and close lifecycles instead.
          if (params.policy !== 'transient-exclusive') return;
          const result = await acquireTransientDeviceClaim({
            device,
            command: params.command,
            workspace: params.workspace,
            stateDir: params.stateDir,
            reconcileOrphanedDeviceClaim: params.reconcileOrphanedDeviceClaim,
          });
          if (result.status === 'conflict') {
            throw deviceClaimConflictError(device, result.conflict);
          }
          if (result.status === 'acquired') acquired.push(result.ownership);
          return;
        }
      }
    },
    [Symbol.asyncDispose]: async () => {
      for (const ownership of acquired.splice(0)) {
        try {
          await clearDeviceClaim(ownership);
        } catch (error) {
          emitDiagnostic({
            level: 'error',
            phase: 'transient_device_claim_release_failed',
            data: {
              command: params.command,
              deviceKey: ownership.deviceKey,
              error: error instanceof Error ? error.message : String(error),
            },
          });
        }
      }
    },
  };
}
