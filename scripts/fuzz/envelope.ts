// Run envelope for the parser fuzz lane (#1414).
//
// A scheduled lane goes dark quietly: it can stop running, or fail for weeks, while PR CI stays
// green. Freshness monitoring therefore needs one machine-readable record per run — green runs
// included — describing which commit, tool, config, and seed produced the verdict. This lane
// writes that record on *every* terminal path: pass, fail, self-check, or a crash in the harness.
// The cross-lane version of this contract is #1430's deliverable; this is only what this lane owes.

import fs from 'node:fs';
import path from 'node:path';
import type { FuzzFailure } from './invariant.ts';

const SCHEMA_VERSION = 1;
const FILENAME = 'run-envelope.json';
const LANE = 'parser-fuzz';
const TOOL = 'scripts/fuzz/run.ts';

export type FuzzTargetRun = {
  target: string;
  cases: number;
  failures: number;
  durationMs: number;
};

export type FuzzRunMode = 'generate' | 'replay-corpus' | 'replay-artifact' | 'self-check';

export type FuzzEnvelopeDetails = {
  mode: FuzzRunMode;
  corpusEntries: number;
  targetRuns: FuzzTargetRun[];
  failures: (FuzzFailure & { artifact?: string })[];
  reproCommands: string[];
};

export type FuzzRunEnvelope = {
  schemaVersion: number;
  lane: string;
  /** `error` is for a run that could not complete itself (crash, bad config). */
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
  details: FuzzEnvelopeDetails;
};

function envOrNull(name: string): string | null {
  return process.env[name] ?? null;
}

/** GitHub Actions exports these; a local run simply records `null`. */
function provenanceFromEnv(): FuzzRunEnvelope['provenance'] {
  return {
    commitSha: envOrNull('GITHUB_SHA'),
    ref: envOrNull('GITHUB_REF'),
    workflow: envOrNull('GITHUB_WORKFLOW'),
    workflowRunId: envOrNull('GITHUB_RUN_ID'),
    workflowRunNumber: envOrNull('GITHUB_RUN_NUMBER'),
    workflowRunAttempt: envOrNull('GITHUB_RUN_ATTEMPT'),
    nodeVersion: process.version,
    tool: TOOL,
  };
}

/** Writes the envelope for one fuzz run into `artifactDir`; returns its path. */
export function writeFuzzEnvelope(input: {
  artifactDir: string;
  startedAt: number;
  finishedAt: number;
  result: FuzzRunEnvelope['result'];
  config: Record<string, unknown>;
  details: FuzzEnvelopeDetails;
}): string {
  const envelope: FuzzRunEnvelope = {
    schemaVersion: SCHEMA_VERSION,
    lane: LANE,
    result: input.result,
    startedAt: new Date(input.startedAt).toISOString(),
    finishedAt: new Date(input.finishedAt).toISOString(),
    durationMs: input.finishedAt - input.startedAt,
    provenance: provenanceFromEnv(),
    config: { mode: input.details.mode, ...input.config },
    details: input.details,
  };
  fs.mkdirSync(input.artifactDir, { recursive: true });
  const file = path.join(input.artifactDir, FILENAME);
  fs.writeFileSync(file, `${JSON.stringify(envelope, null, 2)}\n`);
  return file;
}
