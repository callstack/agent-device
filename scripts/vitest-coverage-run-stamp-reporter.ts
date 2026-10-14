// Writes `coverage/coverage-run-stamp.json` at the end of a coverage pass: the tree the pass read, how
// much of the test suite it exercised, and the resolved include/exclude. That record is what lets
// `check:coverage-crap` tell a fresh `coverage/` from one left by an earlier commit, another checkout, a
// narrowed run, or a run whose tree has since been edited; `coverage-crap/stamp.ts` owns the shape, the
// hashing, and reading it back.
//
// The hook is Vitest's `onFinishedReportCoverage`, which it calls only after the coverage provider has
// reported — a plain `vitest run` never reaches it, so an ordinary test lane cannot write a stamp, and it
// runs after the provider's own cleanup, so the stamp can never be swept with the reports. The tree is
// captured at the other end, in `onInit`, and confirmed here; when the two disagree this pass writes
// nothing, which is `stamp.ts`'s decision to make, not this file's.
//
// Recording how much ran matters because a coverage pass reports every file `include` selects whatever it
// ran: point Vitest at one test file and the rest of the tree still lands in the map with no counters,
// which reads as untested code. So `full` has to rest on evidence rather than on nobody noticing a
// narrowing, and each requirement is an observable on the resolved config or on the collected specs.
//
// What a reporter cannot see is `test.only`: a focused case skips its siblings inside a file that is still
// collected, so every module check below passes and the map is partial anyway. Vitest exposes no focus
// state on the entities it reports, so the lane refuses it at the door instead — `test:coverage` runs with
// `--allowOnly=false`, which fails the pass before it reports any coverage. Requiring that resolved
// config to say `false` is what turns "no focus observed" into evidence; the guard test pins the flag
// against the script.

import path from 'node:path';
import type { Reporter, TestSpecification, Vitest } from 'vitest/node';
import {
  beginCoverageRun,
  finishCoverageRun,
  type CoverageRun,
  type RunSelection,
} from './coverage-crap/stamp.ts';

/** `Reporter` plus the hook Vitest calls once the coverage provider has finished reporting. */
type CoverageReporter = Reporter & { onFinishedReportCoverage(): void | Promise<void> };

/**
 * The projects the instrumented invocation is not expected to run, because the coverage script hands them
 * to a separate uninstrumented one. Without this, a pass over every project but the one the lane splits
 * off could never tell itself from a `--project` filter, and every real coverage pass would stamp itself
 * unusable. `vitest.config.ts` owns the list and passes it here, so it is never copied.
 */
type UninstrumentedProjects = readonly string[];

/** The name a declared project entry carries: an inline config names it under `test`, a string is it. */
function declaredProjectName(entry: unknown): string {
  if (typeof entry === 'string') return entry;
  if (typeof entry === 'object' && entry !== null && 'test' in entry) {
    const name = (entry as { test?: { name?: unknown } }).test?.name;
    return typeof name === 'string' ? name : '';
  }
  return '';
}

/**
 * How far this invocation exercised the tests, or the first narrowing the evidence does not support.
 * Order decides only which sentence the reader gets: nothing but `full` can answer for a whole-tree map,
 * so an unprovable shape is refused rather than assumed complete. Observed narrowings come first because
 * they say what ran; `unattested` comes last because it names only a guard that was not in place.
 */
async function detectRunSelection(
  vitest: Vitest,
  specs: ReadonlyArray<TestSpecification>,
  uninstrumented: UninstrumentedProjects,
): Promise<RunSelection> {
  const { config } = vitest;
  if (config.testNamePattern) return 'test-name';
  if (config.shard) return 'shard';
  if (specs.some((spec) => (spec.testIds?.length ?? 0) > 0 || (spec.testLines?.length ?? 0) > 0)) {
    return 'test-ids';
  }
  if ((config.tagsFilter?.length ?? 0) > 0) return 'tags';
  // Two CLI inputs that narrow the test set without leaving any trace in the comparison below, because
  // Vitest resolves them into the config the projects then glob with: `--exclude` is appended to each
  // project's exclude, and `--dir` moves the root those globs are read from. Both leave globbed and
  // collected identical, so the pass looks complete while whole subtrees were never considered.
  if ((config.cliExclude?.length ?? 0) > 0) return 'files';
  if (config.dir) return 'files';
  // Each project's own globs, which is how a filename filter shows up: Vitest resolves those filters
  // before a reporter ever sees the config, so the only trace left is files a project globbed and the
  // run never collected.
  for (const project of vitest.projects) {
    const collected = new Set(
      specs.filter((spec) => spec.project.name === project.name).map((spec) => spec.moduleId),
    );
    const { testFiles } = await project.globTestFiles();
    if (testFiles.some((file) => !collected.has(file))) return 'files';
  }
  const expected = (config.projects ?? [])
    .map(declaredProjectName)
    .filter((name) => name !== '' && !uninstrumented.includes(name))
    .sort();
  const started = vitest.projects.map((project) => project.name).sort();
  if (
    expected.length === 0 ||
    expected.length !== started.length ||
    expected.some((name, index) => name !== started[index])
  ) {
    return 'project';
  }
  // Last, because it proves nothing ran: it withholds the claim that the whole lane did, which is what a
  // permitted `test.only` would have made untrue without leaving any other trace in the evidence above.
  if (config.allowOnly !== false) return 'unattested';
  return 'full';
}

export default function coverageRunStampReporter(
  uninstrumented: UninstrumentedProjects,
): CoverageReporter {
  let vitest: Vitest;
  let specs: ReadonlyArray<TestSpecification> = [];
  // Vitest reports coverage, and so reaches `onFinishedReportCoverage`, for exactly the passes whose
  // `coverage.enabled` was already resolved at `onInit`: it awaits `initCoverageProvider` before either
  // hook and only calls the hook when a provider exists. Measured on 5.0.4, `--coverage` sets the flag
  // before `onInit` and the lane without it leaves it false.
  let run!: CoverageRun;
  return {
    onInit(ctx: Vitest): void {
      vitest = ctx;
      // Opening the run here rather than at `onTestRunStart` is the point: Vitest loads and transforms test
      // modules before it announces the run, so a tree captured at that later hook could already be ahead
      // of the bytes that produced the coverage. Hashing costs about half a second on this checkout, so it
      // happens only for a pass that will report coverage.
      if (ctx.config.coverage?.enabled === true) run = beginCoverageRun(ctx.config.root);
    },
    onTestRunStart(specifications: ReadonlyArray<TestSpecification>): void {
      specs = specifications;
    },
    // Vitest awaits this hook, so the selection may be computed here rather than raced against it.
    async onFinishedReportCoverage(): Promise<void> {
      const { root, coverage } = vitest.config;
      const outcome = finishCoverageRun(
        run,
        path.resolve(root, coverage.reportsDirectory ?? 'coverage'),
        { include: coverage.include ?? [], exclude: coverage.exclude ?? [] },
        await detectRunSelection(vitest, specs, uninstrumented),
      );
      if ('moved' in outcome) {
        // A pass cannot describe a tree it did not read for its whole life. Verification refuses the
        // reports either way; this says so at the moment the developer can still re-run the pass.
        process.stderr.write(
          'coverage run stamp not kept: this checkout changed while the tests ran. ' +
            'Run `pnpm test:coverage` again.\n',
        );
      }
    },
  };
}
