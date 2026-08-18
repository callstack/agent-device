import type { DeviceInfo } from '@agent-device/kernel/device';
import type { RuntimeOwnerRef } from '@agent-device/contracts/platform';
import type { DeviceClaimPolicy } from '../core/command-descriptor/types.ts';
import { emitDiagnostic } from '../utils/diagnostics.ts';
import { deviceClaimConflictError } from './device-claim-conflict.ts';
import {
  acquireTransientDeviceClaim,
  clearDeviceClaim,
  isLocalDeviceClaimTarget,
  type DeviceClaimReconciler,
  type DeviceClaimSessionOwnership,
} from './device-claims.ts';

/**
 * The #1320 claim gate a request passes on its way from a device binding to
 * device operations. It is built from the executing command's declared
 * {@link DeviceClaimPolicy}, so `transient-exclusive` enforcement cannot be
 * forgotten by a handler: there is no other way to obtain device operations.
 *
 * `admit` is called once per device binding by the request runtime bindings,
 * which is where per-device deduplication already lives.
 */
export type DeviceClaimAdmission = AsyncDisposable &
  Readonly<{
    /** Throws `DEVICE_IN_USE` when a foreign live claim owns the device. */
    admit(device: DeviceInfo, owner: RuntimeOwnerRef): Promise<void>;
  }>;

const NO_CLAIM_INTERACTION: DeviceClaimAdmission = Object.freeze({
  admit: async () => {},
  [Symbol.asyncDispose]: async () => {},
});

export function createDeviceClaimAdmission(params: {
  policy: DeviceClaimPolicy;
  command: string;
  workspace: string;
  stateDir: string;
  reconcileOrphanedDeviceClaim: DeviceClaimReconciler;
}): DeviceClaimAdmission {
  // `none`/`observe`/`require-owner` never read or write the claim store, and
  // `acquire-session`/`release-session` own the session claim through the open
  // and close lifecycles instead.
  if (params.policy !== 'transient-exclusive') return NO_CLAIM_INTERACTION;

  // The caller admits once per device binding, so this only has to remember what
  // it took in order to give it back.
  const acquired: DeviceClaimSessionOwnership[] = [];

  return {
    admit: async (device, owner) => {
      // Remote/provider devices are owned by their provider lease, exactly as
      // `open` decides through the admitted runtime owner rather than flags.
      if (!isLocalDeviceClaimTarget(owner)) return;
      const result = await acquireTransientDeviceClaim({
        device,
        command: params.command,
        workspace: params.workspace,
        stateDir: params.stateDir,
        reconcileOrphanedDeviceClaim: params.reconcileOrphanedDeviceClaim,
      });
      if (result.status === 'conflict') throw deviceClaimConflictError(device, result.conflict);
      if (result.status === 'acquired') acquired.push(result.ownership);
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
