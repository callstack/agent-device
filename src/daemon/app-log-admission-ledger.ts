import {
  deviceIdentity,
  deviceIdentityKey,
  type DeviceIdentity,
  type DeviceInfo,
} from '@agent-device/kernel/device';
import { AppError } from '@agent-device/kernel/errors';

const DEFAULT_UNDURABLE_CLEANUP_TTL_MS = 5 * 60_000;

export type RetainedLegacyAppLogMarker = Readonly<{
  markerPath: string;
  device?: DeviceIdentity;
}>;

export type AppLogAdmissionLedgerOptions = Readonly<{
  now?: () => number;
  undurableCleanupTtlMs?: number;
  onUndurableCleanupExpired?: (block: Readonly<{ device: DeviceIdentity; reason: string }>) => void;
}>;

/** Process-lifetime admission evidence that is intentionally reset by daemon restart. */
export type AppLogAdmissionLedger = Readonly<{
  retainLegacyMarkers(markers: readonly RetainedLegacyAppLogMarker[]): void;
  blockUndurableCleanup(device: DeviceInfo, reason: string): void;
  clearUndurableCleanup(device: DeviceInfo): void;
  assertStartAllowed(device: DeviceInfo): void;
}>;

export function createAppLogAdmissionLedger(
  options: AppLogAdmissionLedgerOptions = {},
): AppLogAdmissionLedger {
  const now = options.now ?? Date.now;
  const ttlMs = options.undurableCleanupTtlMs ?? DEFAULT_UNDURABLE_CLEANUP_TTL_MS;
  const undurableCleanupBlocks = new Map<
    string,
    Readonly<{ device: DeviceIdentity; reason: string; expiresAt: number }>
  >();
  const retainedLegacyMarkers = new Map<string, RetainedLegacyAppLogMarker>();
  return Object.freeze({
    retainLegacyMarkers(markers: readonly RetainedLegacyAppLogMarker[]): void {
      for (const marker of markers) retainedLegacyMarkers.set(marker.markerPath, marker);
    },
    blockUndurableCleanup(device: DeviceInfo, reason: string): void {
      const identity = deviceIdentity(device);
      undurableCleanupBlocks.set(deviceIdentityKey(identity), {
        device: identity,
        reason,
        expiresAt: now() + ttlMs,
      });
    },
    clearUndurableCleanup(device: DeviceInfo): void {
      undurableCleanupBlocks.delete(deviceIdentityKey(deviceIdentity(device)));
    },
    assertStartAllowed(device: DeviceInfo): void {
      const identity = deviceIdentity(device);
      const retained = [...retainedLegacyMarkers.values()].find(
        (marker) =>
          marker.device === undefined ||
          deviceIdentityKey(marker.device) === deviceIdentityKey(identity),
      );
      if (retained) {
        throw new AppError(
          'COMMAND_FAILED',
          'A retained legacy app-log marker prevents replacement capture',
          {
            reason: 'cleanup-unconfirmed',
            hint: 'Inspect and remove the retained app-log.pid only after manually confirming its process is gone.',
          },
        );
      }

      const key = deviceIdentityKey(identity);
      const block = undurableCleanupBlocks.get(key);
      if (!block) return;
      if (now() > block.expiresAt) {
        undurableCleanupBlocks.delete(key);
        options.onUndurableCleanupExpired?.({ device: block.device, reason: block.reason });
        return;
      }
      throw new AppError(
        'COMMAND_FAILED',
        'The existing app-log resource has process-local unconfirmed ownership',
        {
          reason: 'cleanup-unconfirmed',
          hint: `Do not start a replacement in this daemon process: ${block.reason}`,
        },
      );
    },
  });
}
