// Entry point for the scheduled-lane health watcher (#1430). Reads the
// `schedule:`-triggered workflows from `.github/workflows/`, fetches each one's
// recent scheduled runs from the GitHub API, evaluates freshness with the pure
// model, and opens/pings a single tracking issue when any lane missed or failed
// two consecutive cadences. All decision logic lives in `model.ts`; this file is
// only I/O and is meant to run in CI via `node --experimental-strip-types`.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { runCmdSync } from '../../src/utils/exec.ts';
import {
  ALERT_ISSUE_TITLE,
  buildAlertBody,
  discoverScheduledLanes,
  evaluateLaneHealth,
  parseScheduledLane,
  resolveScheduleAnchor,
  type LaneHealth,
  type LaneRun,
} from './model.ts';

const SELF_WORKFLOW_FILE = 'scheduled-lane-health.yml';
const GITHUB_API = 'https://api.github.com';

export type GithubContext = {
  token: string;
  owner: string;
  repo: string;
  runUrl?: string;
};

function readContext(): GithubContext {
  const token = process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN;
  if (!token) throw new Error('GITHUB_TOKEN (or GH_TOKEN) is required');
  const { owner, repo, repository } = resolveRepository();
  return { token, owner, repo, runUrl: resolveRunUrl(repository) };
}

function resolveRepository(): { owner: string; repo: string; repository: string } {
  const repository = process.env.GITHUB_REPOSITORY; // "owner/repo"
  if (!repository || !repository.includes('/')) {
    throw new Error('GITHUB_REPOSITORY must be set to "owner/repo"');
  }
  const [owner, repo] = repository.split('/');
  return { owner, repo, repository };
}

function resolveRunUrl(repository: string): string | undefined {
  const { GITHUB_SERVER_URL, GITHUB_RUN_ID } = process.env;
  if (!GITHUB_SERVER_URL || !GITHUB_RUN_ID) return undefined;
  return `${GITHUB_SERVER_URL}/${repository}/actions/runs/${GITHUB_RUN_ID}`;
}

function requestHeaders(ctx: GithubContext, hasBody: boolean): Record<string, string> {
  const headers: Record<string, string> = {
    accept: 'application/vnd.github+json',
    authorization: `Bearer ${ctx.token}`,
    'x-github-api-version': '2022-11-28',
    'user-agent': 'agent-device-scheduled-lane-health',
  };
  if (hasBody) headers['content-type'] = 'application/json';
  return headers;
}

async function readResponse(
  response: Response,
  method: string,
  url: string,
): Promise<unknown> {
  if (!response.ok) {
    const text = await response.text();
    throw new Error(`GitHub API ${method} ${url} failed: ${response.status} ${text}`);
  }
  return response.status === 204 ? undefined : await response.json();
}

async function githubRequest(
  ctx: GithubContext,
  method: string,
  url: string,
  body?: unknown,
): Promise<unknown> {
  const response = await fetch(url.startsWith('http') ? url : `${GITHUB_API}${url}`, {
    method,
    headers: requestHeaders(ctx, body !== undefined),
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return await readResponse(response, method, url);
}

function workflowsDir(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  return path.resolve(here, '../../.github/workflows');
}

function readWorkflowFiles(dir: string): { file: string; content: string }[] {
  return fs
    .readdirSync(dir)
    .filter((file) => file.endsWith('.yml') || file.endsWith('.yaml'))
    .map((file) => ({ file, content: fs.readFileSync(path.join(dir, file), 'utf8') }));
}

async function fetchScheduledRuns(
  ctx: GithubContext,
  workflowFile: string,
): Promise<LaneRun[]> {
  const data = (await githubRequest(
    ctx,
    'GET',
    `/repos/${ctx.owner}/${ctx.repo}/actions/workflows/${workflowFile}/runs?event=schedule&per_page=20`,
  )) as { workflow_runs?: { conclusion: string | null; created_at: string }[] };
  return (data.workflow_runs ?? []).map((run) => ({
    conclusion: run.conclusion,
    createdAt: run.created_at,
  }));
}

function gitLines(repoDir: string, args: readonly string[]): string[] {
  const result = runCmdSync('git', [...args], { cwd: repoDir, allowFailure: true });
  if (result.exitCode !== 0) return [];
  return result.stdout
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

/** File content at a git revision, or undefined if the path did not exist there. */
function fileAtRev(repoDir: string, rev: string, relPath: string): string | undefined {
  const result = runCmdSync('git', ['show', `${rev}:${relPath}`], {
    cwd: repoDir,
    allowFailure: true,
  });
  return result.exitCode === 0 ? result.stdout : undefined;
}

/** Whether the workflow content at a revision is `schedule:`-triggered (YAML, not a text match). */
function isScheduledAt(relPath: string, content: string | undefined): boolean {
  if (content === undefined) return false;
  return parseScheduledLane(path.basename(relPath), content) !== undefined;
}

/**
 * Committer/landing time of the most recent unscheduled→scheduled transition of
 * a workflow on the default branch's first-parent history — i.e. when the lane's
 * *current* schedule actually became active. This is the correct newborn-grace
 * anchor: it's the schedule-introduction, not the (possibly ancient) workflow
 * file `created_at`; it uses committer time so it reflects when the change
 * landed rather than when it was authored; it parses YAML so a comment
 * mentioning `schedule:` can't match; and taking the newest transition survives
 * a schedule being removed and later re-added. Returns undefined when git
 * history is unavailable (e.g. a shallow checkout), leaving `resolveScheduleAnchor`
 * to fall back to the earliest run or the current time.
 */
export function deriveScheduleActivatedAt(params: {
  repoDir: string;
  relPath: string;
}): string | undefined {
  const { repoDir, relPath } = params;
  // Commits that changed the file, newest first, along default-branch
  // first-parent history, tagged with committer (landing) time.
  const lines = gitLines(repoDir, ['log', '--first-parent', '--format=%H %cI', '--', relPath]);
  let firstAppearanceAt: string | undefined;
  for (const line of lines) {
    const sep = line.indexOf(' ');
    if (sep === -1) continue;
    const sha = line.slice(0, sep);
    const committedAt = line.slice(sep + 1).trim();
    firstAppearanceAt = committedAt; // oldest commit touching the file wins (last iteration)
    const scheduledNow = isScheduledAt(relPath, fileAtRev(repoDir, sha, relPath));
    const scheduledBefore = isScheduledAt(relPath, fileAtRev(repoDir, `${sha}^1`, relPath));
    if (scheduledNow && !scheduledBefore) return committedAt;
  }
  // Scheduled since the file first appeared (no unscheduled ancestor): anchor on
  // that first appearance.
  return firstAppearanceAt;
}

function repoRootDir(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  return path.resolve(here, '../..');
}

export async function findExistingAlertIssue(ctx: GithubContext): Promise<number | undefined> {
  const data = (await githubRequest(
    ctx,
    'GET',
    `/repos/${ctx.owner}/${ctx.repo}/issues?state=open&per_page=100`,
  )) as { title: string; number: number; pull_request?: unknown }[];
  return data.find((issue) => !issue.pull_request && issue.title === ALERT_ISSUE_TITLE)?.number;
}

export async function raiseAlert(ctx: GithubContext, body: string): Promise<void> {
  const existing = await findExistingAlertIssue(ctx);
  if (existing !== undefined) {
    await githubRequest(
      ctx,
      'POST',
      `/repos/${ctx.owner}/${ctx.repo}/issues/${existing}/comments`,
      { body },
    );
    console.log(`Pinged existing alert issue #${existing}`);
    return;
  }
  const created = (await githubRequest(ctx, 'POST', `/repos/${ctx.owner}/${ctx.repo}/issues`, {
    title: ALERT_ISSUE_TITLE,
    body,
  })) as { number: number };
  console.log(`Opened alert issue #${created.number}`);
}

async function main(): Promise<void> {
  const ctx = readContext();
  const now = Date.now();
  const nowIso = new Date(now).toISOString();
  const repoDir = repoRootDir();
  const lanes = discoverScheduledLanes(readWorkflowFiles(workflowsDir()), SELF_WORKFLOW_FILE);
  console.log(`Discovered ${lanes.length} scheduled lane(s): ${lanes.map((l) => l.file).join(', ')}`);

  const healths: LaneHealth[] = [];
  for (const lane of lanes) {
    const runs = await fetchScheduledRuns(ctx, lane.file);
    const registeredAt = resolveScheduleAnchor({
      scheduleActivatedAt: deriveScheduleActivatedAt({
        repoDir,
        relPath: path.posix.join('.github/workflows', lane.file),
      }),
      runs,
      fallback: nowIso,
    });
    const health = evaluateLaneHealth({ lane, runs, now, registeredAt });
    healths.push(health);
    console.log(`${health.healthy ? 'OK  ' : 'DARK'} ${lane.file}: ${health.reason}`);
  }

  const body = buildAlertBody({ healths, now, runUrl: ctx.runUrl });
  if (!body) {
    console.log('All scheduled lanes are fresh — no alert.');
    return;
  }
  await raiseAlert(ctx, body);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
