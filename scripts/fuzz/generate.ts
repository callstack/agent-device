// The generating fuzz run for one target (#1414).
//
// fast-check drives the loop so a violation is reported SHRUNK: the first failing input is
// typically a long mutated string, while the minimized one names the actual parser branch. The
// run stays reproducible — `--seed` is fast-check's seed, and the reported `path` replays the exact
// case, shrink steps included.

import fc from 'fast-check';
import { arbitraryForTarget } from './arbitraries.ts';
import { type CaseRunner, createCaseRunner } from './execute.ts';
import type { FuzzFailure } from './invariant.ts';
import type { FuzzTarget } from './target-types.ts';

export type GeneratedRun = {
  /** Cases actually executed, seeds and shrink candidates included. */
  cases: number;
  failure: FuzzFailure | null;
  /** fast-check's replay coordinates for the counterexample, when there is one. */
  replay?: { seed: number; path: string };
};

export type GenerateOptions = { iterations: number; seed: number; caseTimeoutMs: number };

/** The first seed that already violates the invariant, or `null` when they all hold. */
async function checkSeeds(target: FuzzTarget, runner: CaseRunner): Promise<FuzzFailure | null> {
  for (const seed of target.seeds) {
    const failure = await runner.run(seed);
    if (failure) return failure;
  }
  return null;
}

/**
 * Re-runs the shrunk counterexample, so the reported failure — the one written as an artifact and
 * promoted into the corpus — describes the minimized input rather than the original random one.
 */
async function describeCounterexample(
  target: FuzzTarget,
  runner: CaseRunner,
  input: string,
): Promise<FuzzFailure> {
  const failure = await runner.run(input);
  return (
    failure ?? {
      target: target.name,
      input,
      kind: 'hang',
      detail: 'counterexample no longer reproduces outside the shrink run',
    }
  );
}

/**
 * Fuzzes one target. Seeds run verbatim first: they are the known-good shapes, and a lane that
 * only ever ran generated cases could pass while the plain grammar is broken.
 */
export async function generateAndCheck(
  target: FuzzTarget,
  options: GenerateOptions,
): Promise<GeneratedRun> {
  const runner = await createCaseRunner(target, options.caseTimeoutMs);
  try {
    const seedFailure = await checkSeeds(target, runner);
    if (seedFailure) return { cases: target.seeds.length, failure: seedFailure };
    return await checkGenerated(target, runner, options);
  } finally {
    await runner.close();
  }
}

/** The generated half of a run: fast-check picks the inputs and shrinks any counterexample. */
async function checkGenerated(
  target: FuzzTarget,
  runner: CaseRunner,
  options: GenerateOptions,
): Promise<GeneratedRun> {
  let cases = target.seeds.length;
  const details = await fc.check(
    fc.asyncProperty(arbitraryForTarget(target), async (input) => {
      cases += 1;
      return (await runner.run(input)) === null;
    }),
    { numRuns: Math.max(options.iterations - target.seeds.length, 1), seed: options.seed },
  );
  if (!details.failed) return { cases, failure: null };
  return {
    cases,
    failure: await describeCounterexample(target, runner, counterexampleOf(details)),
    replay: replayOf(details),
  };
}

type CheckDetails = { counterexample: [string] | null; counterexamplePath: string | null };

/** The shrunk input fast-check settled on; `''` when it reported a failure without one. */
function counterexampleOf(details: CheckDetails): string {
  return details.counterexample?.[0] ?? '';
}

/** Coordinates that replay the counterexample, shrink steps included. */
function replayOf(details: CheckDetails & { seed: number }): { seed: number; path: string } {
  return { seed: details.seed, path: details.counterexamplePath ?? '' };
}
