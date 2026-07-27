// Always-produced run envelope for the parser fuzz lane (#1414, scheduled-lane contract of #1412).
//
// A scheduled lane has to be auditable when it passes, not only when it fails: freshness and
// health monitoring need a machine-readable record of *which* code, config, and seed produced
// the verdict. So every run — green or red — writes one JSON envelope next to the artifacts.
// #1430 is standardizing this shape across lanes; when it lands this module becomes the mapping
// onto the shared writer rather than a second definition.

import fs from 'node:fs';
import path from 'node:path';
import type { FuzzFailure } from './invariant.ts';

const SCHEMA_VERSION = 1;
const FILENAME = 'run-envelope.json';

export type FuzzTargetRun = {
  target: string;
  cases: number;
  failures: number;
  durationMs: number;
};

export type FuzzRunEnvelope = {
  schemaVersion: number;
  lane: 'parser-fuzz';
  result: 'pass' | 'fail';
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  provenance: {
    commitSha: string | null;
    ref: string | null;
    workflowRunId: string | null;
    workflowRunAttempt: string | null;
    nodeVersion: string;
    tool: string;
    corpusEntries: number;
  };
  config: {
    mode: 'generate' | 'replay-corpus' | 'self-check';
    seed: number;
    iterations: number;
    caseTimeoutMs: number;
    targets: string[];
  };
  targetRuns: FuzzTargetRun[];
  failures: (FuzzFailure & { artifact?: string })[];
  reproCommands: string[];
};

function envOrNull(name: string): string | null {
  return process.env[name] ?? null;
}

/** GitHub Actions exports these; a local run simply records `null`. */
function provenanceFromEnv() {
  return {
    commitSha: envOrNull('GITHUB_SHA'),
    ref: envOrNull('GITHUB_REF'),
    workflowRunId: envOrNull('GITHUB_RUN_ID'),
    workflowRunAttempt: envOrNull('GITHUB_RUN_ATTEMPT'),
    nodeVersion: process.version,
    tool: 'scripts/fuzz/run.ts',
  };
}

export function buildEnvelope(input: {
  startedAt: number;
  finishedAt: number;
  config: FuzzRunEnvelope['config'];
  corpusEntries: number;
  targetRuns: FuzzTargetRun[];
  failures: (FuzzFailure & { artifact?: string })[];
  reproCommands: string[];
}): FuzzRunEnvelope {
  return {
    schemaVersion: SCHEMA_VERSION,
    lane: 'parser-fuzz',
    result: input.failures.length === 0 ? 'pass' : 'fail',
    startedAt: new Date(input.startedAt).toISOString(),
    finishedAt: new Date(input.finishedAt).toISOString(),
    durationMs: input.finishedAt - input.startedAt,
    provenance: { ...provenanceFromEnv(), corpusEntries: input.corpusEntries },
    config: input.config,
    targetRuns: input.targetRuns,
    failures: input.failures,
    reproCommands: input.reproCommands,
  };
}

/** Writes the envelope into the artifact dir; returns its path. */
export function writeEnvelope(artifactDir: string, envelope: FuzzRunEnvelope): string {
  fs.mkdirSync(artifactDir, { recursive: true });
  const file = path.join(artifactDir, FILENAME);
  fs.writeFileSync(file, `${JSON.stringify(envelope, null, 2)}\n`);
  return file;
}
