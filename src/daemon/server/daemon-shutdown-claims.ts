import { publicPlatformString } from '@agent-device/kernel/device';
import { emitDiagnostic } from '@agent-device/host-kit/diagnostics';
import { clearDeviceClaim, type DeviceClaimClearOutcome } from '../device/device-claims.ts';
import type { DeviceClaimRecord } from '../../daemon-shutdown-report.ts';
import type { SessionState } from '../session-state.ts';

export type DaemonShutdownClaims = {
  released: DeviceClaimRecord[];
  orphaned: DeviceClaimRecord[];
  superseded: DeviceClaimRecord[];
  /**
   * A record this daemon's claim pointed at that yielded nothing attributable, so the daemon cannot
   * say whether it still holds the device. Neither of the two buckets above tells the truth about it:
   * it is not `superseded`, because nothing proves a successor took the device, and it is not
   * `orphaned`, because that bucket's advice is `device release --stale` and that route proves
   * staleness from a recorded owner — which is exactly what a record that never decoded does not have.
   */
  unattributable: DeviceClaimRecord[];
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
 *  - `unattributable` — a record remains where our claim was, but it decoded to
 *                   no owner at all, so this daemon cannot say whether it still
 *                   holds the device. It is NOT `orphaned`, because that bucket
 *                   tells the operator to run `device release --stale`, and that
 *                   route proves staleness from a recorded owner this record does
 *                   not have; it refuses here and `device status --stale` hides
 *                   it. Nor is it `superseded`, which would assert a successor
 *                   this verdict explicitly refuses to assume.
 */
export function createDaemonShutdownClaimLedger(): DaemonShutdownClaimLedger {
  const claims: DaemonShutdownClaims = {
    released: [],
    orphaned: [],
    superseded: [],
    unattributable: [],
  };
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
          claims.unattributable.push(record);
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
