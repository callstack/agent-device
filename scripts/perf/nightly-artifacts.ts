import fs from 'node:fs';
import path from 'node:path';
import { runCmdSync } from '@agent-device/host-kit/command';
import { SUMMARY_FILE } from './report.ts';
import { parsePerfSummary } from './summary.ts';
import type { PerfSummary } from './types.ts';

/** The stable name of the summary artifact that the nightly workflow uploads for every run. */
export const SUMMARY_ARTIFACT = 'perf-ios-summary';

export type WorkflowRun = {
  id: string;
  createdAt: string;
  headSha: string;
  event: string;
};

export type NightlySource = {
  repo: string;
  workflow: string;
  branch: string;
  artifact: string;
  cacheDir: string;
};

const DATE_REF = /^\d{4}-\d{2}-\d{2}$/;

function gh(args: string[]): { ok: boolean; stdout: string; stderr: string } {
  const result = runCmdSync('gh', args, { allowFailure: true, maxBuffer: 64 * 1024 * 1024 });
  return { ok: result.exitCode === 0, stdout: result.stdout, stderr: result.stderr };
}

/** Lists the workflow's completed runs on one branch, newest first. */
export function listRuns(source: NightlySource, limit = 100): WorkflowRun[] {
  const result = gh([
    'run',
    'list',
    '--repo',
    source.repo,
    '--workflow',
    source.workflow,
    '--branch',
    source.branch,
    '--status',
    'completed',
    '--limit',
    String(limit),
    '--json',
    'databaseId,createdAt,headSha,event',
  ]);
  if (!result.ok) throw new Error(`gh run list failed: ${result.stderr.trim()}`);
  const rows = JSON.parse(result.stdout) as {
    databaseId: number;
    createdAt: string;
    headSha: string;
    event: string;
  }[];
  return sortNewestFirst(
    rows.map((row) => ({
      id: String(row.databaseId),
      createdAt: row.createdAt,
      headSha: row.headSha,
      event: row.event,
    })),
  );
}

function sortNewestFirst(runs: WorkflowRun[]): WorkflowRun[] {
  return [...runs].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

/**
 * Resolves one run reference: `latest`, a numeric run id, or a `YYYY-MM-DD` date (the newest run
 * created that UTC day). Returns undefined when no listed run matches.
 */
export function resolveRunRef(ref: string, runs: WorkflowRun[]): WorkflowRun | undefined {
  const newestFirst = sortNewestFirst(runs);
  if (ref === 'latest') return newestFirst[0];
  if (/^\d+$/.test(ref)) return newestFirst.find((run) => run.id === ref);
  if (DATE_REF.test(ref)) return newestFirst.find((run) => run.createdAt.slice(0, 10) === ref);
  throw new Error(
    `Unknown run reference ${JSON.stringify(ref)}: use latest, a run id, a YYYY-MM-DD date, or a path.`,
  );
}

/**
 * Runs between two references inclusive, newest first. A date end covers its whole UTC day, so a
 * dispatch later that day does not hide the night's scheduled run.
 */
export function selectRange(runs: WorkflowRun[], fromRef: string, toRef: string): WorkflowRun[] {
  const bounds = (ref: string): [string, string] | undefined => {
    if (DATE_REF.test(ref)) return [`${ref}T00:00:00Z`, `${ref}T23:59:59.999Z`];
    const run = resolveRunRef(ref, runs);
    return run && [run.createdAt, run.createdAt];
  };
  const from = bounds(fromRef);
  const to = bounds(toRef);
  if (!from || !to) throw new Error(`No runs match the range ${fromRef}..${toRef}.`);
  const low = from[0] < to[0] ? from[0] : to[0];
  const high = from[1] > to[1] ? from[1] : to[1];
  return sortNewestFirst(runs).filter((run) => run.createdAt >= low && run.createdAt <= high);
}

/**
 * A rolling-baseline run must have run every scenario of the target on the same platform, so a
 * partial dispatch does not take the place of a full night.
 */
export function coversTarget(candidate: PerfSummary, target: PerfSummary): boolean {
  return (
    candidate.platform === target.platform &&
    target.config.scenarios.every((scenario) => candidate.config.scenarios.includes(scenario))
  );
}

/** Baseline candidates: runs created before the target, newest first, never the target itself. */
export function baselineCandidates(
  runs: WorkflowRun[],
  before: string,
  exclude: ReadonlySet<string>,
): WorkflowRun[] {
  return sortNewestFirst(runs).filter((run) => run.createdAt < before && !exclude.has(run.id));
}

/**
 * Returns a run's summary, downloading the summary artifact once into the cache. Returns undefined
 * when the run has no such artifact (it failed before upload, or the artifact expired).
 */
export function fetchSummary(source: NightlySource, run: WorkflowRun): PerfSummary | undefined {
  const dir = path.join(source.cacheDir, run.id);
  const file = path.join(dir, SUMMARY_FILE);
  if (!fs.existsSync(file)) {
    fs.rmSync(dir, { recursive: true, force: true });
    const result = gh([
      'run',
      'download',
      run.id,
      '--repo',
      source.repo,
      '--name',
      source.artifact,
      '--dir',
      dir,
    ]);
    if (!result.ok || !fs.existsSync(file)) {
      process.stderr.write(
        `[perf] run ${run.id}: no ${source.artifact} artifact (${result.stderr.trim()})\n`,
      );
      fs.rmSync(dir, { recursive: true, force: true });
      return undefined;
    }
  }
  return parsePerfSummary(JSON.parse(fs.readFileSync(file, 'utf8')), file);
}

/** Reads a local run: a `summary.json` path or a run output directory. */
export function readLocalSummary(location: string): PerfSummary {
  const file = fs.statSync(location).isDirectory() ? path.join(location, SUMMARY_FILE) : location;
  return parsePerfSummary(JSON.parse(fs.readFileSync(file, 'utf8')), file);
}
