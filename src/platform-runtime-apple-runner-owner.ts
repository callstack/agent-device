import type { RunnerDeviceClaimAuthorityProbe } from '@agent-device/platform-apple/runner-owner';

/** Root-composed daemon ownership inputs consumed by the Apple runner host. */
export async function configureAppleRunnerLeaseOwnerStateDir(
  stateDir: string | undefined,
): Promise<void> {
  const { setRunnerLeaseOwnerStateDir } = await import('@agent-device/platform-apple/runner-owner');
  setRunnerLeaseOwnerStateDir(stateDir);
}

export async function configureAppleRunnerDeviceClaimAuthorityProbe(
  probe: RunnerDeviceClaimAuthorityProbe | undefined,
): Promise<void> {
  const { setRunnerDeviceClaimAuthorityProbe } =
    await import('@agent-device/platform-apple/runner-owner');
  setRunnerDeviceClaimAuthorityProbe(probe);
}
