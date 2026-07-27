// Entry point for `pnpm fuzz:parsers` — the nightly parser fuzz lane (#1414).
//
// Feeds mutated hostile input to the CLI/selector/replay/batch/Maestro parsers and enforces
// one invariant: a rejection is a typed AppError with a non-empty hint, and no case hangs.
// Every run writes a machine-readable envelope; failing cases are written as artifacts and
// printed with repro and corpus-promotion commands. `--self-check` runs the broken-on-purpose
// targets instead, so a regressed classifier or watchdog cannot pass silently.

import { readCorpus } from './corpus.ts';
import { buildEnvelope, writeEnvelope, type FuzzTargetRun } from './envelope.ts';
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

/** Replays a saved artifact, optionally promoting it into the checked-in corpus. */
async function replaySavedCase(options: FuzzOptions): Promise<number> {
  const { target, input } = readSavedCase(options.inputFile!);
  const failures = await runTarget(target, [input], options.caseTimeoutMs);
  for (const failure of failures) process.stdout.write(`${describeFailure(failure)}\n`);
  process.stdout.write(verdictLine(target.name, failures.length > 0));
  if (options.appendCorpus) promoteFailures(failures);
  return failures.length === 0 ? 0 : 1;
}

function summaryLine(targetCount: number, seed: number, failed: boolean, envelope: string): string {
  return failed
    ? `\nEnvelope: ${envelope}\n`
    : `Invariant held across ${targetCount} target(s), seed ${seed}. Envelope: ${envelope}\n`;
}

async function fuzzRun(options: FuzzOptions): Promise<number> {
  const startedAt = Date.now();
  const targets = selectTargets(options.target);
  const { failures, targetRuns } = await fuzzTargets(targets, options);
  const { reported, reproCommands } = reportFailures(failures, options.artifactDir);
  if (options.appendCorpus) promoteFailures(failures);

  const envelope = writeEnvelope(
    options.artifactDir,
    buildEnvelope({
      startedAt,
      finishedAt: Date.now(),
      config: {
        mode: options.replayCorpus ? ('replay-corpus' as const) : ('generate' as const),
        seed: options.seed,
        iterations: options.iterations,
        caseTimeoutMs: options.caseTimeoutMs,
        targets: targets.map((target) => target.name),
      },
      corpusEntries: readCorpus().length,
      targetRuns,
      failures: reported,
      reproCommands,
    }),
  );
  process.stdout.write(summaryLine(targets.length, options.seed, failures.length > 0, envelope));
  return failures.length === 0 ? 0 : 1;
}

async function main(): Promise<number> {
  const options = readFuzzOptions(process.argv.slice(2));
  if (!options) {
    process.stdout.write(FUZZ_USAGE);
    return 0;
  }
  if (options.selfCheck) return await runSelfCheck(options);
  if (options.inputFile !== undefined) return await replaySavedCase(options);
  return await fuzzRun(options);
}

process.exitCode = await main();
