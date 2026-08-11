import {
  deviceIdentity,
  deviceIdentityKey,
  type DeviceIdentity,
  type DeviceInfo,
} from '@agent-device/kernel/device';
import { AppError } from '@agent-device/kernel/errors';

const DEFAULT_UNDURABLE_CLEANUP_TTL_MS = 5 * 60_000;

export type DurableCaptureAdmissionLedger = Readonly<{
  blockUndurableCleanup(device: DeviceInfo, reason: string): void;
  clearUndurableCleanup(device: DeviceInfo): void;
  assertStartAllowed(device: DeviceInfo): void;
}>;

export function createDurableCaptureAdmissionLedger(
  options: Readonly<{
    displayName: string;
    now?: () => number;
    undurableCleanupTtlMs?: number;
    onUndurableCleanupExpired?: (
      block: Readonly<{ device: DeviceIdentity; reason: string }>,
    ) => void;
  }>,
): DurableCaptureAdmissionLedger {
  const now = options.now ?? Date.now;
  const ttlMs = options.undurableCleanupTtlMs ?? DEFAULT_UNDURABLE_CLEANUP_TTL_MS;
  const blocks = new Map<
    string,
    Readonly<{ device: DeviceIdentity; reason: string; expiresAt: number }>
  >();
  return Object.freeze({
    blockUndurableCleanup(device: DeviceInfo, reason: string): void {
      const identity = deviceIdentity(device);
      blocks.set(deviceIdentityKey(identity), {
        device: identity,
        reason,
        expiresAt: now() + ttlMs,
      });
    },
    clearUndurableCleanup(device: DeviceInfo): void {
      blocks.delete(deviceIdentityKey(deviceIdentity(device)));
    },
    assertStartAllowed(device: DeviceInfo): void {
      const identityKey = deviceIdentityKey(deviceIdentity(device));
      const block = blocks.get(identityKey);
      if (!block) return;
      if (now() > block.expiresAt) {
        blocks.delete(identityKey);
        options.onUndurableCleanupExpired?.({ device: block.device, reason: block.reason });
        return;
      }
      throw new AppError(
        'COMMAND_FAILED',
        `The existing ${options.displayName.toLowerCase()} resource has process-local unconfirmed ownership`,
        {
          reason: 'cleanup-unconfirmed',
          hint: `Do not start a replacement in this daemon process: ${block.reason}`,
        },
      );
    },
  });
}
