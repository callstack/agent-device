// `pnpm lanes:health` — the scheduled-lane health/freshness consumer (#1430).
//
// Reads every `schedule:`-triggered workflow out of .github/workflows/, asks the GitHub API for its
// recent scheduled runs, and classifies each lane as healthy, failing, or dark. Output is both
// human (step summary) and machine readable: `lane-health.json` carries the freshness fields the
// repo-health snapshot consumes, alongside the standard lane envelope for this job's own run.
// `--dry-run` skips the alert issue, which is what the local/no-token path uses.

import fs from 'node:fs';
import path from 'node:path';
import { discoverScheduledLanes } from './discover.ts';
import { buildLaneEnvelope, writeLaneEnvelope } from './envelope.ts';
import { fetchScheduledRuns, upsertAlertIssue } from './github-api.ts';
import { healthTable, laneHealth, type LaneHealth, unhealthyLanes } from './health-model.ts';

const ALERT_TITLE = 'Scheduled lane alert: a nightly/weekly lane is dark or failing';
const WORKFLOW_DIR = '.github/workflows';
const SNAPSHOT_FILE = 'lane-health.json';
const RUNS_PER_LANE = 10;

type Options = { artifactDir: string; dryRun: boolean; repo: string; token: string | undefined };

function artifactDirFrom(argv: readonly string[]): string {
  const flag = argv.indexOf('--artifact-dir');
  return flag === -1 ? '.tmp/lane-health' : (argv[flag + 1] ?? '.tmp/lane-health');
}

function readOptions(argv: readonly string[]): Options {
  return {
    artifactDir: artifactDirFrom(argv),
    dryRun: argv.includes('--dry-run') || process.env.GITHUB_TOKEN === undefined,
    repo: process.env.GITHUB_REPOSITORY ?? 'callstack/agent-device',
    token: process.env.GITHUB_TOKEN,
  };
}

async function collectHealth(options: Options): Promise<LaneHealth[]> {
  const now = Date.now();
  const lanes: LaneHealth[] = [];
  for (const cadence of discoverScheduledLanes(WORKFLOW_DIR)) {
    const history =
      options.token === undefined
        ? { known: false, reason: 'no GITHUB_TOKEN: run history not read', runs: [] }
        : await fetchScheduledRuns({
            token: options.token,
            repo: options.repo,
            workflow: cadence.workflow,
            perPage: RUNS_PER_LANE,
          });
    lanes.push(laneHealth(cadence, history, now));
  }
  return lanes;
}

function writeSummary(lanes: readonly LaneHealth[], unhealthy: readonly LaneHealth[]): void {
  const summaryFile = process.env.GITHUB_STEP_SUMMARY;
  const table = healthTable(lanes);
  process.stdout.write(`${table}\n`);
  if (summaryFile === undefined) return;
  const verdict = unhealthy.length === 0 ? 'All scheduled lanes are within cadence.' : '';
  fs.appendFileSync(summaryFile, `### Scheduled lane health\n\n${table}\n\n${verdict}\n`);
}

function alertBody(unhealthy: readonly LaneHealth[]): string {
  return [
    'These scheduled lanes missed their cadence or failed twice in a row:',
    '',
    healthTable(unhealthy),
    '',
    `Reported by \`pnpm lanes:health\` (run ${process.env.GITHUB_RUN_ID ?? 'local'}).`,
  ].join('\n');
}

async function alert(options: Options, unhealthy: readonly LaneHealth[]): Promise<void> {
  if (unhealthy.length === 0 || options.dryRun || options.token === undefined) return;
  const body = alertBody(unhealthy);
  const result = await upsertAlertIssue({
    token: options.token,
    repo: options.repo,
    title: ALERT_TITLE,
    body,
  });
  process.stdout.write(`Alert issue #${result.number} ${result.action}.\n`);
}

async function main(): Promise<number> {
  const startedAt = Date.now();
  const options = readOptions(process.argv.slice(2));
  const lanes = await collectHealth(options);
  const unhealthy = unhealthyLanes(lanes);
  fs.mkdirSync(options.artifactDir, { recursive: true });
  fs.writeFileSync(
    path.join(options.artifactDir, SNAPSHOT_FILE),
    `${JSON.stringify({ generatedAt: new Date(startedAt).toISOString(), lanes }, null, 2)}\n`,
  );
  writeSummary(lanes, unhealthy);
  await alert(options, unhealthy);
  writeLaneEnvelope(
    options.artifactDir,
    buildLaneEnvelope({
      lane: 'scheduled-lane-health',
      tool: 'scripts/scheduled-lane/health.ts',
      result: unhealthy.length === 0 ? 'pass' : 'fail',
      startedAt,
      finishedAt: Date.now(),
      config: { repo: options.repo, dryRun: options.dryRun, runsPerLane: RUNS_PER_LANE },
      details: { lanes, unhealthy: unhealthy.map((lane) => lane.workflow) },
    }),
  );
  // Dark/failing lanes are reported, not enforced by this job's own status: the alert issue is the
  // signal, and a red health job would itself be a lane that needs watching.
  return 0;
}

process.exitCode = await main();
