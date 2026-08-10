import { deviceIdentity, deviceIdentityKey, type DeviceInfo } from '@agent-device/kernel/device';
import { AppError } from '@agent-device/kernel/errors';

/** Process-lifetime admission evidence that is intentionally reset by daemon restart. */
export type AppLogAdmissionLedger = Readonly<{
  retainLegacyMarkers(markerPaths: readonly string[]): void;
  blockUndurableCleanup(device: DeviceInfo, reason: string): void;
  clearUndurableCleanup(device: DeviceInfo): void;
  assertStartAllowed(device: DeviceInfo): void;
}>;

export function createAppLogAdmissionLedger(): AppLogAdmissionLedger {
  const undurableCleanupBlocks = new Map<string, string>();
  const retainedLegacyMarkers = new Set<string>();
  return Object.freeze({
    retainLegacyMarkers(markerPaths: readonly string[]): void {
      for (const markerPath of markerPaths) retainedLegacyMarkers.add(markerPath);
    },
    blockUndurableCleanup(device: DeviceInfo, reason: string): void {
      undurableCleanupBlocks.set(deviceIdentityKey(deviceIdentity(device)), reason);
    },
    clearUndurableCleanup(device: DeviceInfo): void {
      undurableCleanupBlocks.delete(deviceIdentityKey(deviceIdentity(device)));
    },
    assertStartAllowed(device: DeviceInfo): void {
      if (retainedLegacyMarkers.size > 0) {
        throw new AppError(
          'COMMAND_FAILED',
          'A retained legacy app-log marker prevents replacement capture',
          {
            reason: 'cleanup-unconfirmed',
            hint: 'Inspect and remove the retained app-log.pid only after manually confirming its process is gone.',
          },
        );
      }

      const reason = undurableCleanupBlocks.get(deviceIdentityKey(deviceIdentity(device)));
      if (!reason) return;
      throw new AppError(
        'COMMAND_FAILED',
        'The existing app-log resource has process-local unconfirmed ownership',
        {
          reason: 'cleanup-unconfirmed',
          hint: `Do not start a replacement in this daemon process: ${reason}`,
        },
      );
    },
  });
}
