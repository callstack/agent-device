import type { DaemonInstallSource } from '../kernel/contracts.ts';
import { AppError } from '../kernel/errors.ts';

export function parseGitHubActionsArtifactInstallSourceSpec(
  spec: string,
  sourceLabel: string = '--github-actions-artifact',
): DaemonInstallSource {
  const separator = spec.indexOf(':');
  if (separator <= 0 || separator === spec.length - 1) {
    throw new AppError(
      'INVALID_ARGS',
      `${sourceLabel} must use owner/repo:artifact, for example thymikee/RNCLI83:6635342232`,
    );
  }
  const { owner, repo } = parseRepositorySlug(spec.slice(0, separator), sourceLabel);
  return buildGitHubActionsArtifactInstallSource(
    owner,
    repo,
    spec.slice(separator + 1),
    `${sourceLabel} artifact`,
  );
}

export function parseInstallSourceConfig(value: unknown, sourceLabel: string): DaemonInstallSource {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new AppError('INVALID_ARGS', `${sourceLabel} installSource must be an object.`);
  }
  const record = value as Record<string, unknown>;
  const type = readRequiredText(record.type, `${sourceLabel} installSource.type`);
  if (type !== 'github-actions-artifact') {
    throw new AppError(
      'INVALID_ARGS',
      `${sourceLabel} installSource.type must be "github-actions-artifact".`,
    );
  }
  const { owner, repo } = parseRepositorySlug(
    readRequiredText(record.repo, `${sourceLabel} installSource.repo`),
    `${sourceLabel} installSource.repo`,
  );
  return buildGitHubActionsArtifactInstallSource(
    owner,
    repo,
    record.artifact,
    `${sourceLabel} installSource.artifact`,
  );
}

function buildGitHubActionsArtifactInstallSource(
  owner: string,
  repo: string,
  artifact: unknown,
  artifactField: string,
): DaemonInstallSource {
  if (typeof artifact === 'number' || isIntegerString(artifact)) {
    return {
      kind: 'github-actions-artifact',
      owner,
      repo,
      artifactId: readInteger(artifact, artifactField),
    };
  }
  const artifactName = readRequiredText(artifact, artifactField);
  return {
    kind: 'github-actions-artifact',
    owner,
    repo,
    artifactName,
  };
}

function parseRepositorySlug(value: string, sourceLabel: string): { owner: string; repo: string } {
  const separator = value.indexOf('/');
  if (
    separator <= 0 ||
    separator === value.length - 1 ||
    value.indexOf('/', separator + 1) !== -1
  ) {
    throw new AppError('INVALID_ARGS', `${sourceLabel} must use owner/repo.`);
  }
  const result = {
    owner: value.slice(0, separator).trim(),
    repo: value.slice(separator + 1).trim(),
  };
  if (!result.owner || !result.repo) {
    throw new AppError('INVALID_ARGS', `${sourceLabel} must use owner/repo.`);
  }
  return result;
}

function readText(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;
}

function readRequiredText(value: unknown, field: string): string {
  const text = readText(value);
  if (!text) throw new AppError('INVALID_ARGS', `${field} must be a non-empty string.`);
  return text;
}

function readInteger(value: unknown, field: string): number {
  const parsed =
    typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : NaN;
  if (!Number.isInteger(parsed)) {
    throw new AppError('INVALID_ARGS', `${field} must be an integer.`);
  }
  return parsed;
}

function isIntegerString(value: unknown): value is string {
  return typeof value === 'string' && /^\d+$/.test(value.trim());
}
