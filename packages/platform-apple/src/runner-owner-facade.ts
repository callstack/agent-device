export {
  setAppleRunnerHostEnvironment,
  setRunnerDeviceClaimAuthorityProbe,
  setRunnerLeaseOwnerStateDir,
  type RunnerDeviceClaimAuthorityProbe,
} from './core/runner-owner-state.ts';

export async function restoreLegacyXctestDeviceSetRedirect(
  ...args: Parameters<
    (typeof import('@agent-device/apple-runner'))['restoreLegacyXctestDeviceSetRedirect']
  >
): Promise<void> {
  const { restoreLegacyXctestDeviceSetRedirect: restore } =
    await import('@agent-device/apple-runner');
  await restore(...args);
}
