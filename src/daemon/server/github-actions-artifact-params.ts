import type { DaemonInstallSource } from '@agent-device/kernel/contracts';
import { AppError } from '@agent-device/kernel/errors';
import { assertGitHubRepositoryNamePart } from '@agent-device/provision-kit/install-source-config';

type GitHubActionsArtifactInstallSource = Extract<
  DaemonInstallSource,
  { kind: 'github-actions-artifact' }
>;

/** Reads a `github-actions-artifact` install source from RPC params, refusing ambiguous shapes. */
export function parseGitHubActionsArtifactSource(
  record: Record<string, unknown>,
): GitHubActionsArtifactInstallSource {
  const owner = assertGitHubRepositoryNamePart(readRequiredGitHubArtifactText(record, 'owner'));
  const repo = assertGitHubRepositoryNamePart(readRequiredGitHubArtifactText(record, 'repo'));
  const hasArtifactId = record.artifactId !== undefined;
  const hasRunId = record.runId !== undefined;
  const hasArtifactName = record.artifactName !== undefined;
  if (hasArtifactId && (hasRunId || hasArtifactName)) {
    throw new AppError(
      'INVALID_ARGS',
      'Invalid params: source must specify either artifactId or artifactName, not both',
    );
  }
  if (!hasArtifactId && hasRunId && !hasArtifactName) {
    throw new AppError(
      'INVALID_ARGS',
      'Invalid params: source.artifactName is required when source.runId is specified',
    );
  }
  if (!hasArtifactId && !hasArtifactName) {
    throw new AppError(
      'INVALID_ARGS',
      'Invalid params: source must specify artifactId or artifactName',
    );
  }
  if (hasArtifactId) {
    return {
      kind: 'github-actions-artifact',
      owner,
      repo,
      artifactId: readGitHubArtifactInteger(record, 'artifactId'),
    };
  }
  let runId: number | undefined;
  if (hasRunId) {
    runId = readGitHubArtifactInteger(record, 'runId');
  }
  return {
    kind: 'github-actions-artifact',
    owner,
    repo,
    ...(hasRunId ? { runId } : {}),
    artifactName: readRequiredGitHubArtifactText(record, 'artifactName'),
  };
}

function readRequiredGitHubArtifactText(
  record: Record<string, unknown>,
  key: 'owner' | 'repo' | 'artifactName',
): string {
  const value = typeof record[key] === 'string' ? record[key].trim() : '';
  if (!value) {
    throw new AppError(
      'INVALID_ARGS',
      `Invalid params: source.${key} is required for github-actions-artifact sources`,
    );
  }
  return value;
}

function readGitHubArtifactInteger(record: Record<string, unknown>, key: 'artifactId' | 'runId') {
  const value = record[key];
  const parsed =
    typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : Number.NaN;
  if (!Number.isInteger(parsed)) {
    throw new AppError('INVALID_ARGS', `Invalid params: source.${key} must be an integer`);
  }
  return parsed;
}
