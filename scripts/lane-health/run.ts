// Scheduled-lane health check (issue #1430): does every `schedule:`-triggered
// workflow still run, and still pass?
//
//   pnpm lane-health              report to stdout + job summary
//   pnpm lane-health --alert      also open/ping the tracking issue
//
// The lane list is DERIVED from .github/workflows/ — a hand-maintained list would
// omit exactly the new lane nobody is watching yet. Run observations come from
// the GitHub API through `gh`, so this needs no elevated scope beyond the token
// the workflow already has.

import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { runCmdSync } from '../../src/utils/exec.ts';
import { parseScriptArgs } from '../lib/cli-args.ts';
import {
  evaluateLane,
  laneCadenceHours,
  renderLaneHealth,
  unhealthy,
  type LaneObservation,
  type LaneVerdict,
} from './cadence.ts';

const repoRoot = runCmdSync('git', ['rev-parse', '--show-toplevel']).stdout.trim();
const WORKFLOW_DIR = '.github/workflows';
const ALERT_TITLE = 'Scheduled lane health: a lane is dark or failing';
const ALERT_LABEL = 'ci';

const USAGE = `Usage: pnpm lane-health [options]

  --alert           Open or ping the tracking issue when a lane is unhealthy
  --repo <o/r>      Repository to query (default: the checkout's origin)
`;

/**
 * The cron expressions each workflow declares, keyed by file name. Parsed by
 * shape rather than with a YAML dependency: `schedule:` blocks are a flat list of
 * `- cron: "..."` lines, and `scheduledLanes` is asserted against the real
 * workflow directory in the tests.
 */
export function scheduledLanes(dir: string): Map<string, string[]> {
  const lanes = new Map<string, string[]>();
  for (const file of fs.readdirSync(dir).sort()) {
    if (!file.endsWith('.yml') && !file.endsWith('.yaml')) continue;
    const yaml = fs.readFileSync(path.join(dir, file), 'utf8');
    const crons = [...yaml.matchAll(/^\s*-\s*cron:\s*["']?(?<cron>[^"'\n]+?)["']?\s*$/gm)].map(
      (match) => match.groups!.cron,
    );
    if (crons.length > 0) lanes.set(file, crons);
  }
  return lanes;
}

type WorkflowRun = { conclusion: string | null; createdAt: string; status: string };

function gh(args: readonly string[]): string {
  return runCmdSync('gh', [...args], { cwd: repoRoot, allowFailure: true }).stdout;
}

/** Recent scheduled runs of one workflow, newest first. */
function recentRuns(lane: string, repo: string): WorkflowRun[] {
  const raw = gh([
    'run',
    'list',
    '--workflow',
    lane,
    '--event',
    'schedule',
    '--limit',
    '10',
    '--json',
    'conclusion,createdAt,status',
    '--repo',
    repo,
  ]);
  if (!raw.trim()) return [];
  return JSON.parse(raw) as WorkflowRun[];
}

export function observe(
  lane: string,
  crons: readonly string[],
  runs: readonly WorkflowRun[],
  declaredAt?: string,
): LaneObservation {
  const finished = runs.filter((run) => run.status === 'completed');
  return {
    lane,
    cadenceHours: laneCadenceHours(crons),
    lastRunAt: runs[0]?.createdAt,
    lastSuccessAt: finished.find((run) => run.conclusion === 'success')?.createdAt,
    recentConclusions: finished.map((run) => run.conclusion ?? 'unknown'),
    declaredAt,
  };
}

/** When the workflow file last changed — the earliest its schedule could fire. */
function declaredAt(lane: string): string | undefined {
  const iso = runCmdSync('git', ['log', '-1', '--format=%cI', '--', `${WORKFLOW_DIR}/${lane}`], {
    cwd: repoRoot,
    allowFailure: true,
  }).stdout.trim();
  return iso || undefined;
}

function appendSummary(markdown: string): void {
  const summary = process.env.GITHUB_STEP_SUMMARY;
  if (summary) fs.appendFileSync(summary, markdown);
  process.stdout.write(markdown);
}

/** One tracking issue, pinged on every unhealthy sweep — never a new issue per run. */
function alert(verdicts: readonly LaneVerdict[], repo: string): void {
  const body = renderLaneHealth(verdicts);
  const existing = gh([
    'issue',
    'list',
    '--search',
    `${ALERT_TITLE} in:title`,
    '--state',
    'open',
    '--json',
    'number',
    '--repo',
    repo,
  ]);
  const open = (existing.trim() ? (JSON.parse(existing) as { number: number }[]) : [])[0];
  if (open) {
    gh(['issue', 'comment', String(open.number), '--body', body, '--repo', repo]);
    process.stdout.write(`lane-health: pinged issue #${open.number}\n`);
    return;
  }
  gh([
    'issue',
    'create',
    '--title',
    ALERT_TITLE,
    '--body',
    body,
    '--label',
    ALERT_LABEL,
    '--repo',
    repo,
  ]);
  process.stdout.write('lane-health: opened the tracking issue\n');
}

function originRepo(): string {
  const url = runCmdSync('git', ['remote', 'get-url', 'origin'], {
    cwd: repoRoot,
    allowFailure: true,
  }).stdout.trim();
  return url.replace(/^.*[:/]([^/]+\/[^/]+?)(?:\.git)?$/, '$1');
}

function main(argv = process.argv.slice(2)): number {
  const values = parseScriptArgs(argv, USAGE, {
    alert: { type: 'boolean', default: false },
    repo: { type: 'string' },
  });
  const repo = values.repo ?? process.env.GITHUB_REPOSITORY ?? originRepo();
  const lanes = scheduledLanes(path.join(repoRoot, WORKFLOW_DIR));
  const now = Date.now();
  const verdicts = [...lanes].map(([lane, crons]) =>
    evaluateLane(observe(lane, crons, recentRuns(lane, repo), declaredAt(lane)), now),
  );
  appendSummary(renderLaneHealth(verdicts));
  const bad = unhealthy(verdicts);
  if (bad.length > 0 && values.alert) alert(bad, repo);
  // Reporting, not gating: a dark lane is tracked in the issue, and failing this
  // job would only add a second red lane nobody is watching.
  return 0;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  process.exitCode = main();
}
