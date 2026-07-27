// Entry point for `pnpm fuzz:parsers` — the nightly parser fuzz lane (#1414).
//
// Feeds mutated hostile input to the CLI/selector/replay/batch/Maestro parsers and enforces
// one invariant: a rejection is a typed AppError with a non-empty hint, and no case hangs.
// Failing cases are written as artifacts, printed with a one-line repro command, and (with
// --append-corpus) appended to the checked-in regression corpus the unit lane replays.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Worker } from 'node:worker_threads';
import { appendToCorpus, readCorpus } from './corpus.ts';
import { describeFailure, type FuzzFailure } from './invariant.ts';
import { generateCases } from './mutate.ts';
import { FUZZ_USAGE, readFuzzOptions, type FuzzOptions } from './options.ts';
import { FUZZ_TARGETS, getFuzzTarget, type FuzzTarget } from './targets.ts';
import type { FuzzWorkerData, FuzzWorkerMessage } from './worker.ts';

const WORKER_PATH = path.join(path.dirname(fileURLToPath(import.meta.url)), 'worker.ts');

/**
 * Runs `cases` against `target` in a worker thread, watchdogging the worker's case cursor so
 * a parser that never returns is reported as a `hang` failure instead of wedging the lane.
 */
async function runTarget(
  target: FuzzTarget,
  cases: string[],
  caseTimeoutMs: number,
): Promise<FuzzFailure[]> {
  const progress = new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT);
  const cursor = new Int32Array(progress);
  const workerData: FuzzWorkerData = { targetName: target.name, cases, progress };
  const worker = new Worker(WORKER_PATH, { workerData });
  const failures: FuzzFailure[] = [];

  return await new Promise<FuzzFailure[]>((resolve, reject) => {
    let settled = false;
    let lastIndex = -1;
    let lastAdvance = Date.now();

    const finish = (result: FuzzFailure[]) => {
      if (settled) return;
      settled = true;
      clearInterval(watchdog);
      void worker.terminate();
      resolve(result);
    };

    const watchdog = setInterval(() => {
      const index = Atomics.load(cursor, 0);
      if (index !== lastIndex) {
        lastIndex = index;
        lastAdvance = Date.now();
        return;
      }
      if (Date.now() - lastAdvance < caseTimeoutMs) return;
      failures.push({
        target: target.name,
        input: cases[index] ?? '',
        kind: 'hang',
        detail: `case ${index} did not finish within ${caseTimeoutMs}ms`,
      });
      finish(failures);
    }, 50);

    worker.on('message', (message: FuzzWorkerMessage) => {
      if (message.kind === 'failure') failures.push(message.failure);
      else finish(failures);
    });
    worker.on('error', (error) => {
      if (settled) return;
      settled = true;
      clearInterval(watchdog);
      reject(error);
    });
    worker.on('exit', () => finish(failures));
  });
}

function writeArtifact(artifactDir: string, failure: FuzzFailure, ordinal: number): string {
  fs.mkdirSync(artifactDir, { recursive: true });
  const file = path.join(artifactDir, `${failure.target}-${failure.kind}-${ordinal}.json`);
  fs.writeFileSync(file, `${JSON.stringify(failure, null, 2)}\n`);
  return file;
}

/** Reads back a saved artifact so a CI failure is one copy-pasteable command away. */
function readSavedCase(inputFile: string): { target: FuzzTarget; input: string } {
  const saved: unknown = JSON.parse(fs.readFileSync(inputFile, 'utf8'));
  const { target, input } = Object(saved) as Record<string, unknown>;
  if (typeof target !== 'string' || typeof input !== 'string') {
    throw new Error(`${inputFile} needs string target and input fields.`);
  }
  return { target: getFuzzTarget(target), input };
}

async function replaySavedCase(options: FuzzOptions): Promise<number> {
  const { target, input } = readSavedCase(options.inputFile!);
  const failures = await runTarget(target, [input], options.caseTimeoutMs);
  for (const failure of failures) process.stdout.write(`${describeFailure(failure)}\n`);
  process.stdout.write(
    failures.length === 0
      ? `Case passes the invariant now (${target.name}).\n`
      : `Case still violates the invariant (${target.name}).\n`,
  );
  return failures.length === 0 ? 0 : 1;
}

function selectTargets(name: string | undefined): FuzzTarget[] {
  return name === undefined ? [...FUZZ_TARGETS] : [getFuzzTarget(name)];
}

function casesFor(target: FuzzTarget, options: FuzzOptions): string[] {
  if (!options.replayCorpus) return generateCases(target.seeds, options.iterations, options.seed);
  return readCorpus()
    .filter((entry) => entry.target === target.name)
    .map((entry) => entry.input);
}

function reportFailures(failures: readonly FuzzFailure[], options: FuzzOptions): void {
  process.stdout.write(`\n${failures.length} invariant violation(s):\n`);
  failures.forEach((failure, ordinal) => {
    const file = writeArtifact(options.artifactDir, failure, ordinal);
    process.stdout.write(`\n${describeFailure(failure)}\n`);
    process.stdout.write(`  input:  ${JSON.stringify(failure.input)}\n`);
    process.stdout.write(`  repro:  pnpm fuzz:parsers --input-file ${file}\n`);
  });
  if (!options.appendCorpus) return;
  const added = appendToCorpus(
    failures.map((failure) => ({
      target: failure.target,
      input: failure.input,
      note: `${failure.kind}: ${failure.detail}`,
    })),
  );
  process.stdout.write(`\nAppended ${added.length} case(s) to the regression corpus.\n`);
}

/** Fuzzes every selected target, printing a per-target line as each finishes. */
async function fuzzTargets(targets: readonly FuzzTarget[], options: FuzzOptions) {
  const allFailures: FuzzFailure[] = [];
  for (const target of targets) {
    const cases = casesFor(target, options);
    const started = Date.now();
    const failures = await runTarget(target, cases, options.caseTimeoutMs);
    const elapsed = Date.now() - started;
    process.stdout.write(
      `${target.name}: ${cases.length} cases, ${failures.length} failures (${elapsed}ms)\n`,
    );
    allFailures.push(...failures);
  }
  return allFailures;
}

async function main(): Promise<number> {
  const options = readFuzzOptions(process.argv.slice(2));
  if (!options) {
    process.stdout.write(FUZZ_USAGE);
    return 0;
  }
  if (options.inputFile !== undefined) return await replaySavedCase(options);

  const targets = selectTargets(options.target);
  const failures = await fuzzTargets(targets, options);
  if (failures.length === 0) {
    process.stdout.write(
      `Invariant held across ${targets.length} target(s), seed ${options.seed}.\n`,
    );
    return 0;
  }
  reportFailures(failures, options);
  return 1;
}

process.exitCode = await main();
