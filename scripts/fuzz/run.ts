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
import { runCases } from './execute.ts';
import { generateAndCheck } from './generate.ts';
import { describeFailure, type FuzzFailure } from './invariant.ts';
import { fallbackFuzzOptions, FUZZ_USAGE, readFuzzOptions, type FuzzOptions } from './options.ts';
import { getFuzzTarget } from './registry.ts';
import { promoteFailures, reportFailures } from './report.ts';
import { readSavedCase } from './saved-case.ts';
import { runSelfCheck } from './self-check.ts';
import type { FuzzTarget } from './target-types.ts';
import { FUZZ_TARGETS } from './targets.ts';

function selectTargets(name: string | undefined): FuzzTarget[] {
  return name === undefined ? [...FUZZ_TARGETS] : [getFuzzTarget(name)];
}

function corpusCasesFor(target: FuzzTarget): string[] {
  return readCorpus()
    .filter((entry) => entry.target === target.name)
    .map((entry) => entry.input);
}

/** One target's run: generated (fast-check, shrinking) or a replay of the checked-in corpus. */
async function runOneTarget(
  target: FuzzTarget,
  options: FuzzOptions,
): Promise<{ cases: number; failures: FuzzFailure[]; replayHint?: string }> {
  if (options.replayCorpus) {
    const cases = corpusCasesFor(target);
    return { cases: cases.length, failures: await runCases(target, cases, options.caseTimeoutMs) };
  }
  const run = await generateAndCheck(target, options);
  return {
    cases: run.cases,
    failures: run.failure ? [run.failure] : [],
    ...(run.replay
      ? { replayHint: `fast-check replay: --seed ${run.replay.seed} (path ${run.replay.path})` }
      : {}),
  };
}

/** Fuzzes every selected target, printing a per-target line as each finishes. */
async function fuzzTargets(targets: readonly FuzzTarget[], options: FuzzOptions) {
  const failures: FuzzFailure[] = [];
  const targetRuns: FuzzTargetRun[] = [];
  for (const target of targets) {
    const started = Date.now();
    const { cases, failures: found, replayHint } = await runOneTarget(target, options);
    const durationMs = Date.now() - started;
    targetRuns.push({ target: target.name, cases, failures: found.length, durationMs });
    process.stdout.write(
      `${target.name}: ${cases} cases, ${found.length} failures (${durationMs}ms)\n`,
    );
    if (replayHint !== undefined) process.stdout.write(`  ${replayHint}\n`);
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
  const failures = await runCases(target, [input], options.caseTimeoutMs);
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

async function run(options: FuzzOptions, startedAt: number): Promise<number> {
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
  const startedAt = Date.now();
  const argv = process.argv.slice(2);
  // Option parsing is inside the guarded path on purpose: a malformed workflow-dispatch input is
  // exactly the kind of terminal failure monitoring must still see an envelope for.
  let options: FuzzOptions | null;
  try {
    options = readFuzzOptions(argv);
  } catch (error) {
    return reportCrash(fallbackFuzzOptions(argv), startedAt, error);
  }
  if (!options) {
    process.stdout.write(FUZZ_USAGE);
    return 0;
  }
  return await run(options, startedAt);
}

process.exitCode = await main();
