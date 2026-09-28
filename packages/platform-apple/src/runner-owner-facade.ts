export {
  setRunnerDeviceClaimAuthorityProbe,
  setRunnerLeaseOwnerStateDir,
  type RunnerDeviceClaimAuthorityProbe,
} from './core/runner-owner-state.ts';

export async function restoreLegacyXctestDeviceSetRedirect(
  ...args: Parameters<
    (typeof import('./runner/legacy-xctest-device-set.ts'))['restoreLegacyXctestDeviceSetRedirect']
  >
): Promise<void> {
  const { restoreLegacyXctestDeviceSetRedirect: restore } =
    await import('./runner/legacy-xctest-device-set.ts');
  restore(...args);
}
