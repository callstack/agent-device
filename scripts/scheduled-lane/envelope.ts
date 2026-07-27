// Standard artifact envelope for scheduled (nightly/weekly) lanes (#1430).
//
// Scheduled lanes go dark quietly: a lane can stop running, or fail for weeks, while PR CI stays
// green. Freshness/health monitoring therefore needs one machine-readable record per run — green
// runs included — describing which commit, tool, config, and seed produced the verdict. This
// module owns that shape so every lane emits the same envelope; a lane contributes only its own
// `lane` name and `details` payload.

import fs from 'node:fs';
import path from 'node:path';

const SCHEMA_VERSION = 1;
const FILENAME = 'run-envelope.json';

export type LaneEnvelope<Details> = {
  schemaVersion: number;
  lane: string;
  /** `error` is for a lane that could not complete its own run (crash, bad config). */
  result: 'pass' | 'fail' | 'error';
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  provenance: {
    commitSha: string | null;
    ref: string | null;
    workflow: string | null;
    workflowRunId: string | null;
    workflowRunNumber: string | null;
    workflowRunAttempt: string | null;
    nodeVersion: string;
    tool: string;
  };
  /** Everything that decides what the run did: seed, sizes, budgets, selected work. */
  config: Record<string, unknown>;
  details: Details;
};

function envOrNull(name: string): string | null {
  return process.env[name] ?? null;
}

/** GitHub Actions exports these; a local run simply records `null`. */
function provenanceFromEnv(tool: string): LaneEnvelope<unknown>['provenance'] {
  return {
    commitSha: envOrNull('GITHUB_SHA'),
    ref: envOrNull('GITHUB_REF'),
    workflow: envOrNull('GITHUB_WORKFLOW'),
    workflowRunId: envOrNull('GITHUB_RUN_ID'),
    workflowRunNumber: envOrNull('GITHUB_RUN_NUMBER'),
    workflowRunAttempt: envOrNull('GITHUB_RUN_ATTEMPT'),
    nodeVersion: process.version,
    tool,
  };
}

export function buildLaneEnvelope<Details>(input: {
  lane: string;
  tool: string;
  result: LaneEnvelope<Details>['result'];
  startedAt: number;
  finishedAt: number;
  config: Record<string, unknown>;
  details: Details;
}): LaneEnvelope<Details> {
  return {
    schemaVersion: SCHEMA_VERSION,
    lane: input.lane,
    result: input.result,
    startedAt: new Date(input.startedAt).toISOString(),
    finishedAt: new Date(input.finishedAt).toISOString(),
    durationMs: input.finishedAt - input.startedAt,
    provenance: provenanceFromEnv(input.tool),
    config: input.config,
    details: input.details,
  };
}

/** Writes the envelope into the artifact dir; returns its path. */
export function writeLaneEnvelope<Details>(
  artifactDir: string,
  envelope: LaneEnvelope<Details>,
): string {
  fs.mkdirSync(artifactDir, { recursive: true });
  const file = path.join(artifactDir, FILENAME);
  fs.writeFileSync(file, `${JSON.stringify(envelope, null, 2)}\n`);
  return file;
}
