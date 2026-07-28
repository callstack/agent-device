// Run envelope for the parser fuzz lane (#1414), on #1430's shared contract.
//
// A scheduled lane goes dark quietly: it can stop running, or fail for weeks, while PR CI stays
// green. Freshness monitoring therefore needs one machine-readable record per run — green runs
// included. This module only maps the lane's own facts onto `scripts/lib/lane-envelope.ts`; the
// envelope shape itself is cross-lane and lives there.
//
// `error` (a crash, or config the harness could not parse) is reported as `result: 'fail'` with
// `data.stage: 'error'`: the shared contract deliberately has two results, and a lane that could
// not complete itself is not a passing lane.

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { laneEnvelope } from '../lib/lane-envelope.ts';
import { runCmdSync } from '../../src/utils/exec.ts';
import type { FuzzFailure } from './invariant.ts';

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

/** `stage` separates "the lane ran and found violations" from "the lane could not run". */
export type FuzzEnvelopeData = FuzzEnvelopeDetails & {
  stage: 'complete' | 'error';
  config: Record<string, unknown>;
};

/** Writes the envelope for one fuzz run into `artifactDir`; returns its path. */
export function writeFuzzEnvelope(input: {
  artifactDir: string;
  startedAt: number;
  finishedAt: number;
  result: 'pass' | 'fail' | 'error';
  config: Record<string, unknown>;
  details: FuzzEnvelopeDetails;
}): string {
  const seed = input.config.seed;
  const envelope = laneEnvelope<FuzzEnvelopeData>({
    lane: LANE,
    commit: runCmdSync('git', ['rev-parse', 'HEAD'], { allowFailure: true }).stdout.trim(),
    tool: { node: process.version, harness: TOOL },
    // The generators are the lane's configuration: a case set is decided by the seed plus the
    // arbitraries, so the harness source is what a drift check has to compare.
    configHash: harnessHash(),
    seed: typeof seed === 'number' ? String(seed) : null,
    startedAtMs: input.startedAt,
    now: input.finishedAt,
    result: input.result === 'pass' ? 'pass' : 'fail',
    data: {
      stage: input.result === 'error' ? 'error' : 'complete',
      config: { mode: input.details.mode, ...input.config },
      ...input.details,
    },
  });
  fs.mkdirSync(input.artifactDir, { recursive: true });
  const file = path.join(input.artifactDir, FILENAME);
  fs.writeFileSync(file, `${JSON.stringify(envelope, null, 2)}\n`);
  return file;
}

/**
 * Content hash of the modules that decide a case set, so drift analysis can tell "the same seed
 * means different inputs now" from "the parsers changed".
 */
function harnessHash(): string {
  const here = path.dirname(new URL(import.meta.url).pathname);
  const digest = crypto.createHash('sha256');
  for (const name of ['arbitraries.ts', 'targets.ts', 'invariant.ts']) {
    digest.update(fs.readFileSync(path.join(here, name)));
  }
  return `sha256:${digest.digest('hex').slice(0, 16)}`;
}
