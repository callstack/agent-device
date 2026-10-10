import type { DeviceInfo } from '@agent-device/kernel/device';
import type { RuntimeOwnerRef } from '@agent-device/contracts/platform-runtime';
import type { DeviceClaimPolicy } from '@agent-device/command-registry/types';
import { emitDiagnostic } from '@agent-device/host-kit/diagnostics';
import { deviceClaimConflictError } from './device-claim-conflict.ts';
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
 * `transient-exclusive`; a provider owner takes nothing.
 *
 * `admit` is called once per device binding by the request runtime bindings,
 * which is where per-device deduplication already lives. A command handler has no other way to obtain
 * device operations, so a handler cannot forget any of this. Two daemon-owned
 * recovery paths do bind outside the seam and are the known gap:
 * application-lifecycle-recovery.ts (ordinary intent, daemon shutdown) and
 * durable-capture-runtime-recovery.ts (exact-owner intent read back from a
 * durable envelope).
 */
export type DeviceClaimAdmission = AsyncDisposable &
  Readonly<{
    /** Throws `DEVICE_IN_USE` when a foreign live claim owns the device. */
    admit(device: DeviceInfo, owner: RuntimeOwnerRef): Promise<void>;
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

  /**
   * Only `transient-exclusive` writes the claim store here: `observe`/`require-owner` never do,
   * and `acquire-session`/`release-session` own the session claim through the open and close
   * lifecycles instead.
   */
  async function admitOrdinaryOwner(device: DeviceInfo): Promise<void> {
    if (params.policy !== 'transient-exclusive') return;
    const result = await acquireTransientDeviceClaim({
      device,
      command: params.command,
      workspace: params.workspace,
      stateDir: params.stateDir,
      reconcileOrphanedDeviceClaim: params.reconcileOrphanedDeviceClaim,
    });
    if (result.status === 'conflict') throw deviceClaimConflictError(device, result.conflict);
    if (result.status === 'acquired') acquired.push(result.ownership);
  }

  return {
    admit: async (device, owner) => {
      switch (deviceClaimRuleForOwner(owner)) {
        case 'none':
          return;
        case 'ordinary':
          return await admitOrdinaryOwner(device);
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
