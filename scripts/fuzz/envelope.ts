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
import { fileURLToPath } from 'node:url';
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
    // fast-check is a case-generation input, not just a dependency: an upgrade can change what a
    // seed produces, so its version belongs in provenance next to Node's.
    tool: { node: process.version, 'fast-check': fastCheckVersion(), harness: TOOL },
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
 * Every module that decides which inputs a seed produces, or what counts as a violation: the
 * arbitraries, the targets they are built for, the generation loop (numRuns, property, shrinking),
 * and the invariant itself. Hashing a subset would let a changed case set look like an unchanged
 * lane, which is exactly the drift this field exists to catch.
 */
export const CASE_GENERATION_INPUTS = [
  'arbitraries.ts',
  'generate.ts',
  'targets.ts',
  'invariant.ts',
  'validation-arbitraries.ts',
  'validation-arbitraries-cli.ts',
  'validation-arbitraries-maestro.ts',
  'validation-values.ts',
  'validation-case.ts',
] as const;

/**
 * Modules reachable from the generation roots that deliberately do NOT feed the hash, because
 * they cannot change what a case contains. Kept as data so `envelope.test.ts` can prove the list
 * above still covers everything else: the domain split moved case generation out of
 * `validation-arbitraries.ts` into two new modules and the hash silently stopped covering them,
 * which is exactly the drift a stale corpus reads as confidence.
 */
export const NON_GENERATING_MODULES: Readonly<Record<string, string>> = {
  'target-types.ts': 'types only — erased at runtime, so no value of it reaches a case',
  'execute.ts': 'runs cases under the watchdog; decides how a case executes, not what it contains',
};

/** Content hash of `CASE_GENERATION_INPUTS`. */
function harnessHash(): string {
  const here = path.dirname(new URL(import.meta.url).pathname);
  const digest = crypto.createHash('sha256');
  for (const name of CASE_GENERATION_INPUTS) {
    digest.update(fs.readFileSync(path.join(here, name)));
  }
  return `sha256:${digest.digest('hex').slice(0, 16)}`;
}

/** The generators read from the installed package, so its version is read from there too. */
function fastCheckVersion(): string {
  const manifest = fileURLToPath(import.meta.resolve('fast-check/package.json'));
  const parsed: unknown = JSON.parse(fs.readFileSync(manifest, 'utf8'));
  const version = (parsed as { version?: unknown }).version;
  return typeof version === 'string' ? version : 'unknown';
}
