import { publicPlatformString } from '@agent-device/kernel/device';
import { emitDiagnostic } from '@agent-device/host-kit/diagnostics';
import { clearDeviceClaim, type DeviceClaimClearOutcome } from '../device/device-claims.ts';
import type { DeviceClaimRecord } from '../daemon-shutdown-report.ts';
import type { SessionState } from '../session-state.ts';

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
 * The clear threw, so this ledger holds no verdict for the session. Its own sentinel rather than an
 * absent map entry, so the classifying switch must account for it by name alongside every real
 * outcome.
 */
const CLEAR_UNRECORDED = 'clear-unrecorded';

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
 *  - `unattributable` also lands in `orphaned`, and only by this declaration: a
 *                   record we could not attribute may still be ours, and an
 *                   exiting daemon's owner identity dies with the process, so
 *                   `device release --stale` proves it stale from here. That is
 *                   not what makes it orphaned at idle-expiry time, where the
 *                   owning daemon stays alive and `--stale` proves the opposite
 *                   — the same record means different things to a process that
 *                   is leaving and one that is staying.
 */
export function createDaemonShutdownClaimLedger(): DaemonShutdownClaimLedger {
  const claims: DaemonShutdownClaims = { released: [], orphaned: [], superseded: [] };
  const outcomes = new Map<string, DeviceClaimClearOutcome | typeof CLEAR_UNRECORDED>();
  return {
    claims,
    releaseClaim: async (session) => {
      if (!session.deviceClaim) return;
      try {
        outcomes.set(session.name, await clearDeviceClaim(session.deviceClaim));
      } catch (error) {
        outcomes.set(session.name, CLEAR_UNRECORDED);
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
      // Exhaustive rather than defaulted: a member added to `DeviceClaimClearOutcome` has to declare
      // which bucket it belongs to here, instead of arriving in `orphaned` unnoticed.
      const outcome = outcomes.get(session.name);
      switch (outcome) {
        case 'deleted':
        case 'absent':
          claims.released.push(record);
          return;
        case 'ownership-changed':
          claims.superseded.push(record);
          return;
        case 'unattributable':
          // A record we could not attribute may still be ours, and an exiting daemon's owner identity
          // dies with the process, so this is the cleanup-pending state `--stale` reconciles from.
          // (Idle expiry holds the same verdict back for retry, where the owning daemon stays alive
          // and `--stale` would prove the claim live — the record means different things to a process
          // that is leaving and one that is staying.)
          claims.orphaned.push(record);
          return;
        case CLEAR_UNRECORDED:
        case undefined:
          // The clear never reported: the claim may still be on disk.
          claims.orphaned.push(record);
          return;
        default:
          assertDeclaredClaimOutcome(outcome);
      }
    },
  };
}

function assertDeclaredClaimOutcome(outcome: never): never {
  throw new Error(`Undeclared device-claim outcome: ${String(outcome)}`);
}
