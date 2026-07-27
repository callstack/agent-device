// Entry point for the scheduled-lane health watcher (#1430). Reads the
// `schedule:`-triggered workflows from `.github/workflows/`, fetches each one's
// recent scheduled runs from the GitHub API, evaluates freshness with the pure
// model, and opens/pings a single tracking issue when any lane missed or failed
// two consecutive cadences. All decision logic lives in `model.ts`; this file is
// only I/O and is meant to run in CI via `node --experimental-strip-types`.

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import {
  ALERT_ISSUE_TITLE,
  buildAlertBody,
  discoverScheduledLanes,
  evaluateLaneHealth,
  resolveScheduleAnchor,
  type LaneHealth,
  type LaneRun,
} from './model.ts';

const SELF_WORKFLOW_FILE = 'scheduled-lane-health.yml';
const GITHUB_API = 'https://api.github.com';

type GithubContext = {
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

/**
 * Author date of the commit that introduced the `schedule:` trigger to a
 * workflow, derived from git history (pickaxe on the literal `schedule:`). This
 * — not the workflow's `created_at` — is when the lane actually started being
 * scheduled, so it's the correct newborn-grace anchor for a schedule added
 * later to an old workflow. Returns undefined when history is unavailable (e.g.
 * a shallow checkout) or the string isn't found; `resolveScheduleAnchor` then
 * falls back to the earliest run or the current time.
 */
function scheduleIntroducedAt(dir: string, workflowFile: string): string | undefined {
  try {
    const rel = path.relative(process.cwd(), path.join(dir, workflowFile));
    const out = execFileSync(
      'git',
      ['log', '--reverse', '--format=%aI', '-S', 'schedule:', '--', rel],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] },
    );
    const first = out.split('\n').find((line) => line.trim().length > 0);
    return first?.trim();
  } catch {
    return undefined;
  }
}

async function findExistingAlertIssue(ctx: GithubContext): Promise<number | undefined> {
  const data = (await githubRequest(
    ctx,
    'GET',
    `/repos/${ctx.owner}/${ctx.repo}/issues?state=open&per_page=100`,
  )) as { title: string; number: number; pull_request?: unknown }[];
  return data.find((issue) => !issue.pull_request && issue.title === ALERT_ISSUE_TITLE)?.number;
}

async function raiseAlert(ctx: GithubContext, body: string): Promise<void> {
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
  const dir = workflowsDir();
  const lanes = discoverScheduledLanes(readWorkflowFiles(dir), SELF_WORKFLOW_FILE);
  console.log(`Discovered ${lanes.length} scheduled lane(s): ${lanes.map((l) => l.file).join(', ')}`);

  const healths: LaneHealth[] = [];
  for (const lane of lanes) {
    const runs = await fetchScheduledRuns(ctx, lane.file);
    const registeredAt = resolveScheduleAnchor({
      scheduleIntroducedAt: scheduleIntroducedAt(dir, lane.file),
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
