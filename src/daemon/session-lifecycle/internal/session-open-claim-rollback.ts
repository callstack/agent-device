import { AppError } from '@agent-device/kernel/errors';
import { emitDiagnostic } from '@agent-device/host-kit/diagnostics';
import {
  abandonDeviceClaim,
  clearDeviceClaim,
  type DeviceClaimSessionOwnership,
} from '../../device-claims.ts';
import type { SessionStore } from '../../session-store.ts';

export async function rollbackNewSessionClaim(params: {
  ownership: DeviceClaimSessionOwnership | undefined;
  effects: { mayHaveStarted: boolean };
  sessionName: string;
  sessionStore: SessionStore;
  error?: unknown;
}): Promise<void> {
  const { ownership, effects, sessionName, sessionStore, error } = params;
  if (!ownership) return;
  const cleanupFailed =
    error instanceof AppError && error.details?.reason === 'ios_boot_cleanup_failed';
  if (!effects.mayHaveStarted && !cleanupFailed) {
    await clearDeviceClaim(ownership);
    return;
  }
  if (sessionStore.get(sessionName)?.deviceClaim?.ownerToken === ownership.ownerToken) return;
  const outcome = await abandonDeviceClaim(ownership);
  emitDiagnostic({
    level: 'warn',
    phase: 'device_claim_open_effects_unconfirmed',
    data: { deviceKey: ownership.deviceKey, outcome },
  });
}
