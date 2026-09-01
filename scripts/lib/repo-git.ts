import { runCmdSync } from '@agent-device/host-kit/command';

export type RepoGit = (args: string[]) => string;

export function repoGit(repoRoot: string): RepoGit {
  return (args) => runCmdSync('git', args, { cwd: repoRoot, allowFailure: true }).stdout.trim();
}

/** History-derivation checks cannot run against a shallow CI clone. */
export function requireUnshallowHistory(git: RepoGit, subject: string): void {
  if (git(['rev-parse', '--is-shallow-repository']) !== 'true') return;
  throw new Error(
    `${subject} needs full history and tags. Run \`git fetch --unshallow --tags\` first.`,
  );
}
