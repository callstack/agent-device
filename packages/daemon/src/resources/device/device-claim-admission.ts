import type { DeviceInfo } from '@agent-device/kernel/device';
import type { RuntimeOwnerRef } from '@agent-device/contracts/platform-runtime';
import type { DeviceClaimPolicy } from '@agent-device/command-registry/types';
import { emitDiagnostic } from '@agent-device/host-kit/diagnostics';
import { deviceClaimConflictError } from './device-claim-conflict.ts';
import { deviceClaimRuleForOwner } from './device-claim-rule.ts';
import {
  abandonDeviceClaim,
  acquireTransientDeviceClaim,
  clearDeviceClaim,
  type DeviceClaimReconciler,
  type DeviceClaimSessionOwnership,
} from '@agent-device/daemon-contracts/device-claims';

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
  /**
   * The session this request runs in, which is the only session whose own claim
   * covers a `transient-exclusive` command. Sessions of one daemon are separate
   * device owners (#3345), so the request's routed session address — not the
   * daemon's process identity — is what admission compares a held claim against.
   * Addresses are copyable, so session equality alone is not ownership: the
   * covered claim must also record this request's workspace.
   */
  session: string;
  workspace: string;
  /**
   * The caller's raw cwd when the request carried one, or nothing for a caller without a
   * workspace of its own (SDK requests). The covered-claim check compares workspaces;
   * {@link workspace} cannot serve it because its daemon-directory fallback would refuse
   * exactly the SDK requests whose own session claims should cover them.
   */
  callerCwd: string | undefined;
  /**
   * Canonicalizes a workspace to the root session routing hashes into a session address.
   * The claim layer cannot reach routing itself, so the composition root hands over the same
   * function routing uses: comparing raw directories would separate a caller that ran `open`
   * at the checkout root from its own claim recorded against that root.
   */
  resolveScopeRoot: (workspace: string | undefined) => string | undefined;
  stateDir: string;
  reconcileOrphanedDeviceClaim: DeviceClaimReconciler;
}): DeviceClaimAdmission {
  // The caller admits once per device binding, so this only has to remember what
  // it took in order to give it back.
  const acquired: DeviceClaimSessionOwnership[] = [];
  const requestScopeRoot = params.resolveScopeRoot(params.callerCwd);

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
      coveredBySession: params.session,
      coveredClaimIsOwnedByRequest: (claim) =>
        !requestScopeRoot || params.resolveScopeRoot(claim.workspace) === requestScopeRoot,
      workspace: params.workspace,
      stateDir: params.stateDir,
      reconcileOrphanedDeviceClaim: params.reconcileOrphanedDeviceClaim,
    });
    if (result.status === 'acquired') {
      acquired.push(result.ownership);
      return;
    }
    if (result.status === 'conflict') {
      // A command-scoped claim this request took for this device covers a re-bind of
      // it; the same claim seen by any other request is a live owner.
      const held = result.conflict.claim;
      if (held && acquired.some((ownership) => ownership.ownerToken === held.ownerToken)) return;
      throw deviceClaimConflictError(device, result.conflict);
    }
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
          // A live record whose unlink failed would refuse this session's own next
          // command, so it must not stay live: abandoned means "holds it for nobody",
          // which the next acquire supersedes.
          try {
            await abandonDeviceClaim(ownership);
          } catch (abandonError) {
            emitDiagnostic({
              level: 'error',
              phase: 'transient_device_claim_abandon_failed',
              data: {
                command: params.command,
                deviceKey: ownership.deviceKey,
                error: abandonError instanceof Error ? abandonError.message : String(abandonError),
              },
            });
          }
        }
      }
    },
  };
}
