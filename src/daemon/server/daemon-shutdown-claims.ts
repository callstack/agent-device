import { publicPlatformString } from '@agent-device/kernel/device';
import { emitDiagnostic } from '../../utils/diagnostics.ts';
import { clearDeviceClaim, type DeviceClaimClearOutcome } from '../device-claims.ts';
import type { DeviceClaimRecord } from '../daemon-shutdown-report.ts';
import type { SessionState } from '../types.ts';

export type DaemonShutdownClaims = {
  released: DeviceClaimRecord[];
  orphaned: DeviceClaimRecord[];
  superseded: DeviceClaimRecord[];
};

export type DaemonShutdownClaimLedger = Readonly<{
  claims: DaemonShutdownClaims;
  /** Runs only once a session's teardown reached a safe terminal state. */
  releaseClaim(session: SessionState): Promise<void>;
  /** Classifies the session's claim once its teardown has finished either way. */
  finalize(session: SessionState): void;
}>;

/**
 * #1320 claim results for `daemon stop`, classified from what clearing actually
 * did rather than from whether it threw:
 *
 *  - `released`   — the claim was confirmed gone after a clean teardown.
 *  - `orphaned`   — teardown left our claim in place. The exiting daemon's owner
 *                   identity dies with the process, so this is the
 *                   cleanup-pending state proof-based reconciliation resolves.
 *  - `superseded` — our claim was already replaced by another owner. It is
 *                   neither released (we released nothing) nor orphaned (no
 *                   claim of ours remains to reconcile), so it gets its own
 *                   bucket instead of being folded into a list whose meaning it
 *                   would break.
 */
export function createDaemonShutdownClaimLedger(): DaemonShutdownClaimLedger {
  const claims: DaemonShutdownClaims = { released: [], orphaned: [], superseded: [] };
  const outcomes = new Map<string, DeviceClaimClearOutcome>();
  return {
    claims,
    releaseClaim: async (session) => {
      if (!session.deviceClaim) return;
      try {
        outcomes.set(session.name, await clearDeviceClaim(session.deviceClaim));
      } catch (error) {
        // An unrecorded outcome stays orphaned: the claim may still be on disk.
        emitDiagnostic({
          level: 'warn',
          phase: 'daemon_shutdown_device_claim_release_failed',
          data: {
            session: session.name,
            deviceKey: session.deviceClaim.deviceKey,
            error: error instanceof Error ? error.message : String(error),
          },
        });
      }
    },
    finalize: (session) => {
      const claim = session.deviceClaim;
      if (!claim) return;
      const record: DeviceClaimRecord = {
        deviceKey: claim.deviceKey,
        session: session.name,
        platform: publicPlatformString(session.device),
        deviceId: session.device.id,
      };
      switch (outcomes.get(session.name)) {
        case 'deleted':
        case 'absent':
          claims.released.push(record);
          return;
        case 'ownership-changed':
          claims.superseded.push(record);
          return;
        default:
          claims.orphaned.push(record);
      }
    },
  };
}
