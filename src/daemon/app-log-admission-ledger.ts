import fs from 'node:fs';
import {
  deviceIdentity,
  deviceIdentityKey,
  type DeviceIdentity,
  type DeviceInfo,
} from '@agent-device/kernel/device';
import { AppError } from '@agent-device/kernel/errors';
import {
  createDurableCaptureAdmissionLedger,
  type DurableCaptureAdmissionLedger,
} from './durable-capture-admission-ledger.ts';

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
export type AppLogAdmissionLedger = DurableCaptureAdmissionLedger &
  Readonly<{
    retainLegacyMarkers(markers: readonly RetainedLegacyAppLogMarker[]): void;
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
  const markerExists = options.markerExists ?? fs.existsSync;
  const durableLedger = createDurableCaptureAdmissionLedger({
    displayName: 'app-log',
    now: options.now,
    undurableCleanupTtlMs: options.undurableCleanupTtlMs,
    onUndurableCleanupExpired: options.onUndurableCleanupExpired,
  });
  const retainedLegacyMarkers = new Map<string, RetainedLegacyAppLogMarker>();
  return Object.freeze({
    ...durableLedger,
    retainLegacyMarkers(markers: readonly RetainedLegacyAppLogMarker[]): void {
      for (const marker of markers) retainedLegacyMarkers.set(marker.markerPath, marker);
    },
    assertStartAllowed(device: DeviceInfo): void {
      const identityKey = deviceIdentityKey(deviceIdentity(device));
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
      durableLedger.assertStartAllowed(device);
    },
  });
}
