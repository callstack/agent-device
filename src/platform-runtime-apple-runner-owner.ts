/** Root-composed daemon ownership input consumed by the Apple runner host. */
export async function configureAppleRunnerLeaseOwnerStateDir(
  stateDir: string | undefined,
): Promise<void> {
  const { setRunnerLeaseOwnerStateDir } = await import('@agent-device/platform-apple/runner-owner');
  setRunnerLeaseOwnerStateDir(stateDir);
}
