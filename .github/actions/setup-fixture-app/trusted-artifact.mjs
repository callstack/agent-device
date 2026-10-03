#!/usr/bin/env node
import process from 'node:process';
import { pathToFileURL } from 'node:url';

const TRUSTED_WORKFLOW_PATH = '.github/workflows/test-app-build-cache.yml';

const PLATFORM_JOB_NAMES = { android: 'Android Release', ios: 'iOS Release' };

export async function findTrustedArtifact({ artifacts, expectedHeadSha, repository, loadRun }) {
  for (const artifact of artifacts) {
    if (!artifactBelongsToRepository(artifact, repository.id)) continue;
    const run = await loadRun(artifact.workflow_run.id);
    if (isTrustedProducerRun({ expectedHeadSha, repository, run })) return artifact.id;
  }
  return undefined;
}

export function classifyProducerState(runs, jobs, { expectedHeadSha, repository, platform }) {
  const run = findExpectedProducerRun(runs, expectedHeadSha, repository.id);
  if (!run) return 'absent';
  const jobName = requirePlatformJobName(platform);
  const platformJob = jobs.find((candidate) => candidate.name === jobName);
  if (platformJob) return classifyRunState(platformJob);
  return run.status === 'completed' ? 'failed' : 'queued';
}

function findExpectedProducerRun(runs, expectedHeadSha, repositoryId) {
  return runs.find((candidate) => isExpectedProducerRun(candidate, expectedHeadSha, repositoryId));
}

function requirePlatformJobName(platform) {
  const jobName = PLATFORM_JOB_NAMES[platform];
  if (!jobName) throw new Error(`unknown fixture platform: ${platform}`);
  return jobName;
}

function artifactBelongsToRepository(artifact, repositoryId) {
  if (artifact.expired) return false;
  return workflowRunBelongsToRepository(artifact.workflow_run, repositoryId);
}

function workflowRunBelongsToRepository(run, repositoryId) {
  if (!run) return false;
  return run.repository_id === repositoryId && run.head_repository_id === repositoryId;
}

function isExpectedProducerRun(run, expectedHeadSha, repositoryId) {
  if (run.head_sha !== expectedHeadSha || run.path !== TRUSTED_WORKFLOW_PATH) return false;
  return runBelongsToRepository(run, repositoryId);
}

function classifyRunState(run) {
  if (new Set(['pending', 'queued', 'waiting']).has(run.status)) return 'queued';
  if (run.status !== 'completed') return 'in_progress';
  return run.conclusion === 'success' ? 'success' : 'failed';
}

function isTrustedProducerRun({ expectedHeadSha, repository, run }) {
  if (run.path !== TRUSTED_WORKFLOW_PATH) return false;
  if (!runBelongsToRepository(run, repository.id)) return false;
  if (run.head_sha === expectedHeadSha) return true;
  return isDefaultBranchPush(run, repository.default_branch);
}

function runBelongsToRepository(run, repositoryId) {
  return run.repository?.id === repositoryId && run.head_repository?.id === repositoryId;
}

function isDefaultBranchPush(run, defaultBranch) {
  return run.event === 'push' && run.head_branch === defaultBranch;
}

async function requestJson(path) {
  const response = await fetch(new URL(path, resolveApiBaseUrl()), {
    headers: {
      Accept: 'application/vnd.github+json',
      Authorization: `Bearer ${resolveToken()}`,
      'X-GitHub-Api-Version': '2022-11-28',
    },
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) throw new Error(`GitHub API ${response.status} for ${path}`);
  return await response.json();
}

function resolveApiBaseUrl() {
  return `${process.env.GITHUB_API_URL || 'https://api.github.com'}/`;
}

function resolveToken() {
  return process.env.GH_TOKEN || process.env.GITHUB_TOKEN || '';
}

async function loadRepository(repositoryName) {
  const repository = await requestJson(`repos/${repositoryName}`);
  return {
    default_branch: repository.default_branch,
    id: repository.id,
  };
}

async function runCli(argv) {
  const [command, repositoryName, ...commandArgs] = argv;
  requireArguments([command, repositoryName], 'command and repository');
  const repository = await loadRepository(repositoryName);
  if (command === 'find') return await runFindCommand(repositoryName, repository, commandArgs);
  if (command === 'producer-state') {
    return await runProducerStateCommand(repositoryName, repository, commandArgs);
  }
  throw new Error(`unknown command: ${command}`);
}

async function runFindCommand(repositoryName, repository, commandArgs) {
  const [artifactName, expectedHeadSha] = commandArgs;
  requireArguments([artifactName, expectedHeadSha], 'artifact name and expected head SHA');
  const result = await requestJson(
    `repos/${repositoryName}/actions/artifacts?name=${encodeURIComponent(artifactName)}&per_page=100`,
  );
  const artifactId = await findTrustedArtifact({
    artifacts: result.artifacts || [],
    expectedHeadSha,
    repository,
    loadRun: (runId) => requestJson(`repos/${repositoryName}/actions/runs/${runId}`),
  });
  process.stdout.write(artifactId === undefined ? '' : String(artifactId));
}

async function runProducerStateCommand(repositoryName, repository, commandArgs) {
  const [expectedHeadSha, platform] = commandArgs;
  requireArguments([expectedHeadSha, platform], 'expected head SHA and platform');
  const result = await requestJson(
    `repos/${repositoryName}/actions/workflows/test-app-build-cache.yml/runs?head_sha=${encodeURIComponent(expectedHeadSha)}&per_page=20`,
  );
  const runs = result.workflow_runs || [];
  const run = findExpectedProducerRun(runs, expectedHeadSha, repository.id);
  const jobs = run ? await loadRunJobs(repositoryName, run.id) : [];
  process.stdout.write(
    classifyProducerState(runs, jobs, { expectedHeadSha, repository, platform }),
  );
}

async function loadRunJobs(repositoryName, runId) {
  const result = await requestJson(
    `repos/${repositoryName}/actions/runs/${runId}/jobs?per_page=100`,
  );
  return result.jobs || [];
}

function requireArguments(values, description) {
  if (values.every(Boolean)) return;
  throw new Error(`trusted-artifact requires ${description}`);
}

function formatError(error) {
  return error instanceof Error ? error.message : String(error);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runCli(process.argv.slice(2)).catch((error) => {
    process.stderr.write(`${formatError(error)}\n`);
    process.exitCode = 1;
  });
}
