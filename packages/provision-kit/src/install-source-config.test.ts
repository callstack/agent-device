import assert from 'node:assert/strict';
import { test } from 'vitest';
import { AppError } from '@agent-device/kernel/errors';
import {
  parseGitHubActionsArtifactInstallSourceSpec,
  parseInstallSourceConfig,
} from './install-source-config.ts';

function assertInvalidArgs(action: () => unknown, message: string): void {
  assert.throws(action, (error: unknown) => {
    if (!(error instanceof AppError)) return false;
    assert.equal(error.code, 'INVALID_ARGS');
    assert.equal(error.message, message);
    assert.equal(error.details, undefined);
    assert.equal(error.cause, undefined);
    return true;
  });
}

test('parses artifact IDs and names into the exact install-source shapes', () => {
  assert.deepEqual(
    parseGitHubActionsArtifactInstallSourceSpec(' callstack / agent-device : 6635342232 '),
    {
      kind: 'github-actions-artifact',
      owner: 'callstack',
      repo: 'agent-device',
      artifactId: 6635342232,
    },
  );
  assert.deepEqual(
    parseGitHubActionsArtifactInstallSourceSpec(
      'thymikee/RNCLI83: rn-android-emulator-debug-pr-19',
    ),
    {
      kind: 'github-actions-artifact',
      owner: 'thymikee',
      repo: 'RNCLI83',
      artifactName: 'rn-android-emulator-debug-pr-19',
    },
  );
});

test('rejects empty or malformed owner/repo:artifact specs with typed errors', () => {
  for (const spec of ['', '  ', ':artifact', 'owner/repo:', 'owner:artifact']) {
    assertInvalidArgs(
      () => parseGitHubActionsArtifactInstallSourceSpec(spec),
      spec === 'owner:artifact'
        ? '--github-actions-artifact must use owner/repo.'
        : '--github-actions-artifact must use owner/repo:artifact, for example thymikee/RNCLI83:6635342232',
    );
  }

  for (const spec of ['/repo:artifact', 'owner/:artifact', 'owner/repo/other:artifact']) {
    assertInvalidArgs(
      () => parseGitHubActionsArtifactInstallSourceSpec(spec),
      '--github-actions-artifact must use owner/repo.',
    );
  }
});

test('parses config fields with whitespace and preserves artifact field names', () => {
  const sourceLabel = 'user config file /tmp/agent-device.json';
  assert.deepEqual(
    parseInstallSourceConfig(
      {
        type: ' github-actions-artifact ',
        repo: ' thymikee / RNCLI83 ',
        artifact: ' 6635342232 ',
      },
      sourceLabel,
    ),
    {
      kind: 'github-actions-artifact',
      owner: 'thymikee',
      repo: 'RNCLI83',
      artifactId: 6635342232,
    },
  );
  assert.deepEqual(
    parseInstallSourceConfig(
      {
        type: 'github-actions-artifact',
        repo: 'callstack/agent-device',
        artifact: 'nightly-release',
      },
      sourceLabel,
    ),
    {
      kind: 'github-actions-artifact',
      owner: 'callstack',
      repo: 'agent-device',
      artifactName: 'nightly-release',
    },
  );
});

test('rejects empty and malformed config fields with typed errors and no cause', () => {
  const sourceLabel = 'project config file /tmp/agent-device.json';
  assertInvalidArgs(
    () => parseInstallSourceConfig(undefined, sourceLabel),
    `${sourceLabel} installSource must be an object.`,
  );
  assertInvalidArgs(
    () => parseInstallSourceConfig([], sourceLabel),
    `${sourceLabel} installSource must be an object.`,
  );
  assertInvalidArgs(
    () =>
      parseInstallSourceConfig({ type: ' ', repo: 'owner/repo', artifact: 'build' }, sourceLabel),
    `${sourceLabel} installSource.type must be a non-empty string.`,
  );
  assertInvalidArgs(
    () =>
      parseInstallSourceConfig({ type: 'url', repo: 'owner/repo', artifact: 'build' }, sourceLabel),
    `${sourceLabel} installSource.type must be "github-actions-artifact".`,
  );
  assertInvalidArgs(
    () =>
      parseInstallSourceConfig(
        { type: 'github-actions-artifact', repo: 'owner/repo/other', artifact: 'build' },
        sourceLabel,
      ),
    `${sourceLabel} installSource.repo must use owner/repo.`,
  );
  assertInvalidArgs(
    () =>
      parseInstallSourceConfig(
        { type: 'github-actions-artifact', repo: 'owner/repo', artifact: ' ' },
        sourceLabel,
      ),
    `${sourceLabel} installSource.artifact must be a non-empty string.`,
  );
  assertInvalidArgs(
    () =>
      parseInstallSourceConfig(
        { type: 'github-actions-artifact', repo: 'owner/repo', artifact: 1.5 },
        sourceLabel,
      ),
    `${sourceLabel} installSource.artifact must be an integer.`,
  );
});
