/** Root-composed daemon ownership input consumed by the Apple runner host. */
export async function configureAppleRunnerLeaseOwnerStateDir(
  stateDir: string | undefined,
): Promise<void> {
  const { setRunnerLeaseOwnerStateDir } =
    await import('./platforms/apple/core/runner-owner-state.ts');
  setRunnerLeaseOwnerStateDir(stateDir);
}
