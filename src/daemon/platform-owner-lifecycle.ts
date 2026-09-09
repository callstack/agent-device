import type { DeviceIdentity, DeviceInfo } from '@agent-device/kernel/device';
import type { OwnedProcessRecordStore } from '@agent-device/host-kit/process';

/** Predicate answering whether this process currently holds an active claim on the device. */
export type DeviceClaimAuthorityProbe = (device: DeviceInfo) => boolean;

export type LegacyAppLogMarkerRecoveryOutcome = Readonly<{
  recovered: readonly string[];
  retained: readonly Readonly<{
    markerPath: string;
    reason: 'invalid' | 'ownership-lost';
    message?: string;
    device?: DeviceIdentity;
  }>[];
}>;

/**
 * Typed startup/shutdown participation for the platform resource owners the daemon coordinates
 * but does not itself implement (#2333): the daemon supplies its own inputs, ordering, and
 * best-effort failure policy, and the root composition wires the concrete platform owners behind
 * this surface. No generic hook bag — every phase this daemon relies on is named here.
 */
export type PlatformOwnerLifecycle = Readonly<{
  /** Publishes the daemon-owned lease-owner state dir and claim-authority probe. */
  configureForDaemonLock(
    input: Readonly<{
      stateDir: string;
      hasDeviceClaimAuthority: DeviceClaimAuthorityProbe;
    }>,
  ): Promise<void>;
  /** Clears the configuration above: on a failed lock acquisition, and on shutdown. */
  clearDaemonLockConfiguration(): Promise<void>;
  /** Startup, before servers open: recovers marker-only app-log sessions left by a prior daemon. */
  recoverLegacyAppLogMarkers(sessionsDir: string): Promise<LegacyAppLogMarkerRecoveryOutcome>;
  /** Startup, before servers open: cleans up orphaned managed Web runtime sessions. */
  cleanupManagedWebOrphans(
    params: Readonly<{
      stateDir: string;
      openWebSessionNames: readonly string[];
      ownedProcessRecords?: OwnedProcessRecordStore;
    }>,
  ): Promise<void>;
  /** Shutdown: resets Android snapshot-helper runtime sessions. */
  resetAndroidSnapshotHelper(): Promise<void>;
}>;
