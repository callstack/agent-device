import fs from 'node:fs';
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
  markerExists?: (markerPath: string) => boolean;
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

function findRetainedLegacyMarker(
  retainedMarkers: Map<string, RetainedLegacyAppLogMarker>,
  identityKey: string,
  markerExists: (markerPath: string) => boolean,
): RetainedLegacyAppLogMarker | undefined {
  let retained: RetainedLegacyAppLogMarker | undefined;
  for (const [markerPath, marker] of retainedMarkers) {
    const matchesDevice =
      marker.device === undefined || deviceIdentityKey(marker.device) === identityKey;
    if (!matchesDevice) continue;
    if (!markerExists(markerPath)) {
      retainedMarkers.delete(markerPath);
      continue;
    }
    retained ??= marker;
  }
  return retained;
}

export function createAppLogAdmissionLedger(
  options: AppLogAdmissionLedgerOptions = {},
): AppLogAdmissionLedger {
  const now = options.now ?? Date.now;
  const markerExists = options.markerExists ?? fs.existsSync;
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
      const identityKey = deviceIdentityKey(identity);
      const retained = findRetainedLegacyMarker(retainedLegacyMarkers, identityKey, markerExists);
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

      const block = undurableCleanupBlocks.get(identityKey);
      if (!block) return;
      if (now() > block.expiresAt) {
        undurableCleanupBlocks.delete(identityKey);
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
