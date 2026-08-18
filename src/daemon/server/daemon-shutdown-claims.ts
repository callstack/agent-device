import { publicPlatformString } from '@agent-device/kernel/device';
import { emitDiagnostic } from '../../utils/diagnostics.ts';
import { clearDeviceClaim } from '../device-claims.ts';
import type { DeviceClaimRecord } from '../daemon-shutdown-report.ts';
import type { SessionState } from '../types.ts';

export type DaemonShutdownClaimLedger = Readonly<{
  claims: { released: DeviceClaimRecord[]; orphaned: DeviceClaimRecord[] };
  /** Runs only once a session's teardown reached a safe terminal state. */
  releaseClaim(session: SessionState): Promise<void>;
  /** Classifies the session's claim once its teardown has finished either way. */
  finalize(session: SessionState): void;
}>;

/**
 * #1320 claim results for `daemon stop`: `released` is a claim cleared after a
 * clean teardown, `orphaned` is one this shutdown left in place. The exiting
 * daemon's owner identity dies with the process, so an orphaned claim is exactly
 * the cleanup-pending state proof-based reconciliation later resolves.
 */
export function createDaemonShutdownClaimLedger(): DaemonShutdownClaimLedger {
  const released: DeviceClaimRecord[] = [];
  const orphaned: DeviceClaimRecord[] = [];
  const releasedSessions = new Set<string>();
  return {
    claims: { released, orphaned },
    releaseClaim: async (session) => {
      if (!session.deviceClaim) return;
      try {
        await clearDeviceClaim(session.deviceClaim);
        releasedSessions.add(session.name);
      } catch (error) {
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
      (releasedSessions.has(session.name) ? released : orphaned).push({
        deviceKey: claim.deviceKey,
        session: session.name,
        platform: publicPlatformString(session.device),
        deviceId: session.device.id,
      });
    },
  };
}
