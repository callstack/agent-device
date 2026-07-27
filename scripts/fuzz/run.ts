// Entry point for `pnpm fuzz:parsers` — the nightly parser fuzz lane (#1414).
//
// Feeds mutated hostile input to the CLI/selector/replay/batch/Maestro parsers and enforces
// one invariant: a rejection is a typed AppError with a non-empty hint, and no case hangs.
// Every terminal path — pass, fail, self-check, or a crash in the harness itself — writes one
// scheduled-lane envelope, so monitoring never reads a missing file. Failing cases are written
// as artifacts and printed with repro and corpus-promotion commands.

import { readCorpus } from './corpus.ts';
import {
  type FuzzEnvelopeDetails,
  type FuzzRunMode,
  type FuzzTargetRun,
  writeFuzzEnvelope,
} from './envelope.ts';
import { runTarget } from './execute.ts';
import { describeFailure, type FuzzFailure } from './invariant.ts';
import { generateCases } from './mutate.ts';
import { FUZZ_USAGE, readFuzzOptions, type FuzzOptions } from './options.ts';
import { getFuzzTarget } from './registry.ts';
import { promoteFailures, reportFailures } from './report.ts';
import { readSavedCase } from './saved-case.ts';
import { runSelfCheck } from './self-check.ts';
import type { FuzzTarget } from './target-types.ts';
import { FUZZ_TARGETS } from './targets.ts';

function selectTargets(name: string | undefined): FuzzTarget[] {
  return name === undefined ? [...FUZZ_TARGETS] : [getFuzzTarget(name)];
}

function casesFor(target: FuzzTarget, options: FuzzOptions): string[] {
  if (!options.replayCorpus) return generateCases(target.seeds, options.iterations, options.seed);
  return readCorpus()
    .filter((entry) => entry.target === target.name)
    .map((entry) => entry.input);
}

/** Fuzzes every selected target, printing a per-target line as each finishes. */
async function fuzzTargets(targets: readonly FuzzTarget[], options: FuzzOptions) {
  const failures: FuzzFailure[] = [];
  const targetRuns: FuzzTargetRun[] = [];
  for (const target of targets) {
    const cases = casesFor(target, options);
    const started = Date.now();
    const found = await runTarget(target, cases, options.caseTimeoutMs);
    const durationMs = Date.now() - started;
    targetRuns.push({
      target: target.name,
      cases: cases.length,
      failures: found.length,
      durationMs,
    });
    process.stdout.write(
      `${target.name}: ${cases.length} cases, ${found.length} failures (${durationMs}ms)\n`,
    );
    failures.push(...found);
  }
  return { failures, targetRuns };
}

function verdictLine(targetName: string, failed: boolean): string {
  return failed
    ? `Case still violates the invariant (${targetName}).\n`
    : `Case passes the invariant now (${targetName}).\n`;
}

type ModeOutcome = {
  mode: FuzzRunMode;
  failed: boolean;
  targetRuns: FuzzTargetRun[];
  details?: Partial<FuzzEnvelopeDetails>;
  summary: (envelope: string) => string;
};

/** Replays a saved artifact, optionally promoting it into the checked-in corpus. */
async function replaySavedCase(options: FuzzOptions): Promise<ModeOutcome> {
  const started = Date.now();
  const { target, input } = readSavedCase(options.inputFile!);
  const failures = await runTarget(target, [input], options.caseTimeoutMs);
  for (const failure of failures) process.stdout.write(`${describeFailure(failure)}\n`);
  process.stdout.write(verdictLine(target.name, failures.length > 0));
  if (options.appendCorpus) promoteFailures(failures);
  return {
    mode: 'replay-artifact',
    failed: failures.length > 0,
    targetRuns: [
      {
        target: target.name,
        cases: 1,
        failures: failures.length,
        durationMs: Date.now() - started,
      },
    ],
    details: { failures },
    summary: (envelope) => `Envelope: ${envelope}\n`,
  };
}

async function selfCheckMode(options: FuzzOptions): Promise<ModeOutcome> {
  const { ok, targetRuns } = await runSelfCheck(options);
  return {
    mode: 'self-check',
    failed: !ok,
    targetRuns,
    summary: (envelope) => `Envelope: ${envelope}\n`,
  };
}

async function fuzzMode(options: FuzzOptions): Promise<ModeOutcome> {
  const targets = selectTargets(options.target);
  const { failures, targetRuns } = await fuzzTargets(targets, options);
  const { reported, reproCommands } = reportFailures(failures, options.artifactDir);
  if (options.appendCorpus) promoteFailures(failures);
  const failed = failures.length > 0;
  return {
    mode: options.replayCorpus ? 'replay-corpus' : 'generate',
    failed,
    targetRuns,
    details: { failures: reported, reproCommands },
    summary: (envelope) =>
      failed
        ? `\nEnvelope: ${envelope}\n`
        : `Invariant held across ${targets.length} target(s), seed ${options.seed}. Envelope: ${envelope}\n`,
  };
}

function runMode(options: FuzzOptions): Promise<ModeOutcome> {
  if (options.selfCheck) return selfCheckMode(options);
  if (options.inputFile !== undefined) return replaySavedCase(options);
  return fuzzMode(options);
}

function configFor(options: FuzzOptions): Record<string, unknown> {
  return {
    seed: options.seed,
    iterations: options.iterations,
    caseTimeoutMs: options.caseTimeoutMs,
    targets: options.target === undefined ? 'all' : [options.target],
  };
}

/** Writes the envelope every terminal path owes the scheduled-lane contract. */
function writeOutcomeEnvelope(
  options: FuzzOptions,
  startedAt: number,
  outcome: ModeOutcome,
  result: 'pass' | 'fail' | 'error',
): string {
  return writeFuzzEnvelope({
    artifactDir: options.artifactDir,
    startedAt,
    finishedAt: Date.now(),
    result,
    config: configFor(options),
    details: {
      mode: outcome.mode,
      corpusEntries: readCorpus().length,
      targetRuns: outcome.targetRuns,
      failures: [],
      reproCommands: [],
      ...outcome.details,
    },
  });
}

/** A harness crash still owes an envelope, otherwise monitoring sees nothing at all. */
function reportCrash(options: FuzzOptions, startedAt: number, error: unknown): number {
  const mode: FuzzRunMode = options.selfCheck ? 'self-check' : 'generate';
  const outcome: ModeOutcome = { mode, failed: true, targetRuns: [], summary: () => '' };
  const envelope = writeOutcomeEnvelope(options, startedAt, outcome, 'error');
  process.stderr.write(`${String(error)}\nEnvelope: ${envelope}\n`);
  return 1;
}

async function run(options: FuzzOptions): Promise<number> {
  const startedAt = Date.now();
  try {
    const outcome = await runMode(options);
    const result = outcome.failed ? 'fail' : 'pass';
    process.stdout.write(
      outcome.summary(writeOutcomeEnvelope(options, startedAt, outcome, result)),
    );
    return outcome.failed ? 1 : 0;
  } catch (error) {
    return reportCrash(options, startedAt, error);
  }
}

async function main(): Promise<number> {
  const options = readFuzzOptions(process.argv.slice(2));
  if (!options) {
    process.stdout.write(FUZZ_USAGE);
    return 0;
  }
  return await run(options);
}

process.exitCode = await main();
