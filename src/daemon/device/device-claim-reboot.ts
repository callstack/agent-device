import type { DeviceBootObservationService } from '@agent-device/contracts/device-boot';
import type { DeviceInfo } from '@agent-device/kernel/device';
import { emitDiagnostic } from '@agent-device/host-kit/diagnostics';
import type { DeviceClaim } from './device-claim-record.ts';

/**
 * The claim `open` released and replaced because its device rebooted after the claim was taken. The
 * reboot destroyed everything the claim was asserting — the app process, the runner, and the
 * accessibility connection — so the claim can no longer describe live device-side ownership, however
 * healthy its recorded owner's process looks.
 */
export type TakenOverDeviceClaim = Readonly<{
  session: string;
  workspace: string;
  stateDir: string;
  bootedAtMs: number;
}>;

/**
 * The instant the owner last vouched for this device — the claim's own write — is the bound a boot
 * has to pass: a device that came up after that has been through a boot this claim never described,
 * and an owner that reopened its app after a reboot has stamped the boot the device is running now.
 * Claims carry no per-request activity stamp by design, and none is needed — an owner whose device
 * rebooted and stayed rebooted lost the session at the reboot, not at the next stale claim check.
 *
 * Both operands are host-clock milliseconds, which is what {@link DeviceBootObservationService}
 * promises; a device clock that disagrees with the host has to stay out of the comparison.
 */
export async function rebootedDeviceClaim(params: {
  claim: DeviceClaim;
  device: DeviceInfo;
  observeDeviceBoot?: DeviceBootObservationService;
}): Promise<TakenOverDeviceClaim | undefined> {
  const observation = await params.observeDeviceBoot?.observeBootTimeMs(params.device);
  if (observation?.observed !== true) return undefined;
  if (observation.bootedAtMs <= params.claim.updatedAtMs) return undefined;
  const { session, workspace, stateDir } = params.claim;
  return { session, workspace, stateDir, bootedAtMs: observation.bootedAtMs };
}

export function emitClaimReleasedAfterDeviceReboot(params: {
  deviceKey: string;
  claim: DeviceClaim;
  bootedAtMs: number;
}): void {
  emitDiagnostic({
    level: 'info',
    phase: 'device_claim_reboot_released',
    data: {
      deviceKey: params.deviceKey,
      ownerSession: params.claim.session,
      ownerStateDir: params.claim.stateDir,
      ownerWorkspace: params.claim.workspace,
      claimUpdatedAtMs: params.claim.updatedAtMs,
      deviceBootedAtMs: params.bootedAtMs,
    },
  });
}
