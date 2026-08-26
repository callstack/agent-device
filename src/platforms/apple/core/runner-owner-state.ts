/**
 * Daemon-owned lease-owner state directory for the Apple runner. Kept in a
 * dedicated tiny module so daemon startup can set it without loading the
 * runner client's implementation closure; the runner package reads it through
 * its host port at lease time.
 */
let runnerLeaseOwnerStateDir: string | undefined;

export function setRunnerLeaseOwnerStateDir(stateDir: string | undefined): void {
  runnerLeaseOwnerStateDir = stateDir?.trim() || undefined;
}

export function getRunnerLeaseOwnerStateDir(): string | undefined {
  return runnerLeaseOwnerStateDir;
}
