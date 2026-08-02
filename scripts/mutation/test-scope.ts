// Which tests the mutation lane runs, derived from Vitest's module graph.
//
// Stryker replays the configured suite for every mutant, so the suite it is
// pointed at decides whether the weekly sweep fits its 30-minute budget. Pointing
// it at the whole unit suite (487 files) makes the initial dry run alone cost
// minutes; hand-listing per-kernel test files would be a second source of truth
// that silently rots. So the scope is derived the same way `pnpm check:affected`
// derives affected tests: `vitest related` over the mutated files, i.e. Vitest's
// own static module graph.
//
// Two files are removed from whatever Vitest returns:
//   - the subprocess-stub group (it spawns stubbed binaries and waits real
//     subprocess/retry/poll time — out of scope by the issue's constraint, and
//     thousands of mutant runs would turn it into timeout noise);
//   - tests that cannot run in the thread pool Stryker's vitest runner forces:
//     the in-process CLI-capture tests (`process.chdir` throws in a worker
//     thread) and the `node:worker_threads` PNG pipeline tests (a worker inside
//     a worker raises uncaught MessagePort errors that kill the runner);
//   - anything outside `src/` or a workspace package's `src/`: the unit suite
//     also hosts the help-conformance gates from `scripts/__tests__`, which
//     assert over the repo's own registries rather than any decision kernel
//     and own their CI job.
//
// Nothing here weakens the ratchet: a mutant only an excluded test could kill
// shows up as a survivor — visible work, never a silent pass.

import fs from 'node:fs';
import path from 'node:path';
import { runCmdSync } from '../../src/utils/exec.ts';
import { readWorkspacePackages } from '../layering/package-boundaries.ts';
import { walkFiles } from '../lib/walk-files.ts';
import { isKernelTestFile, normalizePath } from './modules.ts';

/** Env var carrying the resolved scope file to `vitest.mutation.config.ts`. */
export const TEST_SCOPE_ENV = 'AGENT_DEVICE_MUTATION_TEST_FILES';
const CLI_CAPTURE_HARNESS = 'src/__tests__/cli-capture.ts';

/**
 * Every directory the mutation lane can find a test file under: root `src/`
 * plus each workspace package's `src/` (`unit-core`'s own `include` list in
 * `vitest.config.ts`). A kernel living in `packages/*` — `kernel-errors`
 * reaches its tests only indirectly, but `target-annotation-serde` is tested
 * directly from inside its package — must not lose its owning tests to a
 * root-only walk.
 */
function testFileRoots(repoRoot: string): string[] {
  return [
    path.join(repoRoot, 'src'),
    ...readWorkspacePackages(repoRoot).map((pkg) => path.join(repoRoot, pkg.dir, 'src')),
  ];
}

/** Source modules that own a `node:worker_threads` worker. */
function workerThreadModules(repoRoot: string): string[] {
  return testFileRoots(repoRoot)
    .flatMap((root) =>
      walkFiles(root, (file) => file.endsWith('.ts') && !file.endsWith('.test.ts')),
    )
    .filter((file) => fs.readFileSync(file, 'utf8').includes('node:worker_threads'))
    .map((file) => path.basename(file, '.ts'));
}

/**
 * Repo-relative test files that cannot survive Stryker's thread pool, derived
 * from what they import rather than listed: the chdir-using CLI capture harness
 * and any module that itself starts a worker thread.
 */
export function threadHostileTestFiles(repoRoot: string): string[] {
  const modules = [path.basename(CLI_CAPTURE_HARNESS, '.ts'), ...workerThreadModules(repoRoot)];
  const importsHostileModule = new RegExp(`from '[^']*/(${modules.join('|')})(\\.ts)?'`);
  return testFileRoots(repoRoot)
    .flatMap((root) => walkFiles(root, (file) => file.endsWith('.test.ts')))
    .filter((file) => importsHostileModule.test(fs.readFileSync(file, 'utf8')))
    .map((file) => normalizePath(path.relative(repoRoot, file)))
    .sort();
}

/**
 * Concrete source files behind a module's mutate globs. Stryker's `!`-prefixed
 * exclusions are applied here too — `fs.globSync` has no notion of them, and
 * dropping them would feed selector *tests* into the scope derivation.
 */
export function expandMutateFiles(globs: readonly string[], repoRoot: string): string[] {
  const negated = globs.filter((glob) => glob.startsWith('!')).map((glob) => glob.slice(1));
  const excluded = new Set(fs.globSync(negated, { cwd: repoRoot }).map(normalizePath));
  return fs
    .globSync(
      globs.filter((glob) => !glob.startsWith('!')),
      { cwd: repoRoot },
    )
    .map(normalizePath)
    .filter((file) => !excluded.has(file))
    .sort();
}

type VitestJsonReport = { testResults?: readonly { name: string }[] };

/**
 * Test files Vitest considers related to `sourceFiles`, minus the groups this
 * lane cannot run. `vitest related` executes them once (seconds), which also
 * proves the scope is green before Stryker's dry run depends on it.
 */
export function relatedTestFiles(
  sourceFiles: readonly string[],
  repoRoot: string,
  excluded: readonly string[] = threadHostileTestFiles(repoRoot),
): string[] {
  const reportFile = path.join(repoRoot, '.tmp/mutation/related-tests.json');
  fs.mkdirSync(path.dirname(reportFile), { recursive: true });
  fs.rmSync(reportFile, { force: true });
  runCmdSync(
    'pnpm',
    [
      'exec',
      'vitest',
      'related',
      ...sourceFiles,
      '--project',
      'unit-core',
      '--run',
      '--reporter=json',
      `--outputFile=${reportFile}`,
    ],
    { cwd: repoRoot, allowFailure: true },
  );
  if (!fs.existsSync(reportFile)) {
    throw new Error(
      `vitest related produced no report at ${reportFile} — cannot derive the mutation test scope.`,
    );
  }
  const report = JSON.parse(fs.readFileSync(reportFile, 'utf8')) as VitestJsonReport;
  const excludedSet = new Set(excluded);
  return [
    ...new Set(
      (report.testResults ?? [])
        .map((result) => normalizePath(path.relative(repoRoot, result.name)))
        .filter((file) => isKernelTestFile(file) && !excludedSet.has(file)),
    ),
  ].sort();
}

/** Read the scope Stryker was handed, or `undefined` for "whole unit suite". */
export function readTestScope(): string[] | undefined {
  const file = process.env[TEST_SCOPE_ENV];
  if (!file || !fs.existsSync(file)) return undefined;
  const files = JSON.parse(fs.readFileSync(file, 'utf8')) as string[];
  return files.length > 0 ? files : undefined;
}

export function writeTestScope(files: readonly string[], file: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(files, null, 2)}\n`);
}
