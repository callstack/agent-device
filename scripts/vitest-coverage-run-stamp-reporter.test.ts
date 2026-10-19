import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, test } from 'node:test';
import type { TestSpecification, Vitest } from 'vitest/node';
import coverageRunStampReporter from './vitest-coverage-run-stamp-reporter.ts';
import { COVERAGE_UNINSTRUMENTED_PROJECTS } from '../vitest.config.ts';
import { COVERAGE_STAMP_FILE, type CoverageStamp } from './coverage-crap/stamp.ts';

// The reporter is the only writer of the stamp, and it hangs off hooks Vitest calls on its own schedule,
// so nothing else exercises its real decisions: which directory the record lands in, whether the checkout
// moved while the pass ran, and whether the run that reached the end may claim the whole coverage lane.
// These drive the hooks in Vitest's order against a real git repo with the smallest ctx that carries those
// inputs, and read the file back.

let repo: string;

const UNIT_TESTS = ['src/a.test.ts', 'src/b.test.ts'];
const APPLE_TESTS = ['packages/platform-apple/src/runner/x.test.ts'];
/** The projects a full coverage pass runs, as opposed to the ones the lane splits off. */
const LANE_PROJECTS = [
  { name: 'unit-core', testFiles: UNIT_TESTS },
  { name: 'apple-runner', testFiles: APPLE_TESTS },
];

function git(...args: string[]): string {
  return execFileSync('git', args, { cwd: repo, encoding: 'utf8' }).trim();
}

function write(rel: string, content: string): void {
  const abs = path.join(repo, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content);
}

/** One collected spec, as far as the reporter reads it: a project name and a module id. */
function spec(projectName: string, moduleId: string): TestSpecification {
  return { project: { name: projectName }, moduleId } as unknown as TestSpecification;
}

function laneSpecs(): TestSpecification[] {
  return [
    spec('unit-core', path.join(repo, 'src/a.test.ts')),
    spec('unit-core', path.join(repo, 'src/b.test.ts')),
    spec('apple-runner', path.join(repo, 'packages/platform-apple/src/runner/x.test.ts')),
  ];
}

/** The Vitest ctx the reporter reads: resolved config plus the projects it can ask for their globs. */
function stubCtx(
  projects: ReadonlyArray<{ name: string; testFiles: readonly string[] }>,
  declaredNames: readonly string[],
  overrides: { coverage?: Record<string, unknown>; config?: Record<string, unknown> } = {},
): Vitest {
  return {
    config: {
      root: repo,
      // The flag the lane passes, and the one piece of evidence `full` cannot rest without.
      allowOnly: false,
      projects: declaredNames.map((name) => ({ test: { name } })),
      coverage: { enabled: true, ...overrides.coverage },
      ...overrides.config,
    },
    projects: projects.map((project) => ({
      name: project.name,
      globTestFiles: async () => ({
        testFiles: project.testFiles.map((file) => path.join(repo, file)),
        typecheckTestFiles: [],
      }),
    })),
  } as unknown as Vitest;
}

/**
 * A pass over the whole lane: every instrumented project, every file each one's globs name. The declared
 * list carries the projects the coverage script hands to a separate uninstrumented invocation, so the
 * ordinary case below is also the case that would read as a filter without that declaration.
 */
function laneCtx(overrides: Parameters<typeof stubCtx>[2] = {}): Vitest {
  return stubCtx(
    LANE_PROJECTS,
    ['unit-core', 'apple-runner', ...COVERAGE_UNINSTRUMENTED_PROJECTS],
    overrides,
  );
}

/** Drives the reporter's hooks in Vitest's order and returns the record it wrote, if it wrote one. */
async function stampAfterRun(
  ctx: Vitest,
  collected: readonly TestSpecification[],
): Promise<CoverageStamp | null> {
  const reporter = coverageRunStampReporter(COVERAGE_UNINSTRUMENTED_PROJECTS);
  reporter.onInit?.(ctx);
  await reporter.onTestRunStart?.(collected);
  await reporter.onFinishedReportCoverage();
  const stampPath = path.join(repo, 'coverage', COVERAGE_STAMP_FILE);
  return fs.existsSync(stampPath)
    ? (JSON.parse(fs.readFileSync(stampPath, 'utf8')) as CoverageStamp)
    : null;
}

beforeEach(() => {
  repo = fs.mkdtempSync(path.join(os.tmpdir(), 'coverage-stamp-reporter-'));
  git('init', '-q');
  git('config', 'user.email', 'test@example.com');
  git('config', 'user.name', 'Test');
  // The record lives in the reports directory, so that directory has to stay outside the tree the hash
  // describes — mirroring this repository's own `.gitignore`, which is what keeps the write from moving
  // the hash it just computed.
  write('.gitignore', 'coverage/\n');
  write('src/a.ts', 'export const a = 1;\n');
  write('src/b.ts', 'export const b = 1;\n');
  git('add', '-A');
  git('commit', '-q', '-m', 'base');
});

afterEach(() => {
  fs.rmSync(repo, { recursive: true, force: true });
});

test('a run that collected every project and file stamps the lane as full', async () => {
  const written = await stampAfterRun(
    laneCtx({ coverage: { reportsDirectory: 'coverage' } }),
    laneSpecs(),
  );

  assert.ok(written);
  assert.equal(written.runSelection, 'full');
  assert.equal(written.head, git('rev-parse', 'HEAD'));
  assert.deepEqual(written.include, []);
  assert.deepEqual(written.exclude, []);
});

test('the record lands in the configured reports directory, resolved from the root', async () => {
  await stampAfterRun(laneCtx({ coverage: { reportsDirectory: 'out/coverage' } }), laneSpecs());

  assert.ok(fs.existsSync(path.join(repo, 'out/coverage', COVERAGE_STAMP_FILE)));
  assert.ok(!fs.existsSync(path.join(repo, 'coverage', COVERAGE_STAMP_FILE)));
});

test('a config that declares no reports directory or scope still stamps the defaults', async () => {
  // Vitest resolves `reportsDirectory` to `coverage` and leaves an undeclared scope absent, so the writer
  // has to supply both rather than write `undefined` into the record.
  const written = await stampAfterRun(laneCtx(), laneSpecs());

  assert.ok(written);
  assert.deepEqual(written.include, []);
  assert.deepEqual(written.exclude, []);
});

test('a declared scope reaches the record in sorted order', async () => {
  const written = await stampAfterRun(
    laneCtx({
      coverage: { include: ['src/**/*.ts', 'packages/*/src/**/*.ts'], exclude: ['**/*.test.ts'] },
    }),
    laneSpecs(),
  );

  assert.ok(written);
  assert.deepEqual(written.include, ['packages/*/src/**/*.ts', 'src/**/*.ts']);
  assert.deepEqual(written.exclude, ['**/*.test.ts']);
});

test('a file written while the pass ran writes no record', async () => {
  // The tree the tests loaded is the one the stamp may describe, so a pass that raced an edit on a source
  // file declines instead of pinning bytes the run never read.
  const reporter = coverageRunStampReporter(COVERAGE_UNINSTRUMENTED_PROJECTS);
  const ctx = laneCtx();
  reporter.onInit?.(ctx);
  await reporter.onTestRunStart?.(laneSpecs());

  write('src/b.ts', 'export const b = 2;\n');
  await reporter.onFinishedReportCoverage();

  assert.ok(!fs.existsSync(path.join(repo, 'coverage', COVERAGE_STAMP_FILE)));
});

test('a file written before the run was announced still keeps the pass from stamping', async () => {
  // Vitest loads and transforms test modules before it announces the run, so capturing the tree at
  // `onTestRunStart` would already be ahead of the bytes that produced the coverage. The opening hash is
  // taken at `onInit`, which is what makes this edit visible at the end.
  const reporter = coverageRunStampReporter(COVERAGE_UNINSTRUMENTED_PROJECTS);
  reporter.onInit?.(laneCtx());

  write('src/b.ts', 'export const b = 2;\n');
  await reporter.onTestRunStart?.(laneSpecs());
  await reporter.onFinishedReportCoverage();

  assert.ok(!fs.existsSync(path.join(repo, 'coverage', COVERAGE_STAMP_FILE)));
});

test('a project filter is stamped as a partial run', async () => {
  const written = await stampAfterRun(
    stubCtx(
      [LANE_PROJECTS[0]!],
      ['unit-core', 'apple-runner', ...COVERAGE_UNINSTRUMENTED_PROJECTS],
    ),
    laneSpecs().slice(0, 2),
  );

  assert.ok(written);
  assert.equal(written.runSelection, 'project');
});

test('a config that declares no projects is stamped as partial rather than full', async () => {
  // Nothing can prove a run covered the lane when the lane is undeclared, and the shape that would fail
  // open is exactly the one that must not. Every file the one started project globs did run, so this is
  // the project evidence deciding, not a file filter.
  const written = await stampAfterRun(stubCtx([LANE_PROJECTS[0]!], []), laneSpecs().slice(0, 2));

  assert.ok(written);
  assert.equal(written.runSelection, 'project');
});

test('CLI --exclude and --dir are stamped as partial even when the globs agree', async () => {
  // Vitest folds `--exclude` into each project's resolved exclude and moves the glob root for `--dir`, so
  // a run started that way globs and collects the same reduced set: the file comparison below cannot see
  // either one, and the map it writes calls every excluded file untested. These contexts are built to be
  // exactly that shape — globs equal to what was collected — so only the resolved config can refuse them.
  for (const config of [{ cliExclude: ['packages/**'] }, { dir: 'src' }]) {
    const written = await stampAfterRun(laneCtx({ config }), laneSpecs());

    assert.ok(written, JSON.stringify(config));
    assert.notEqual(written.runSelection, 'full', JSON.stringify(config));
    assert.equal(written.runSelection, 'files', JSON.stringify(config));
  }
});

test('a filename filter is stamped as a partial run', async () => {
  // Vitest resolves `vitest run src/a.test.ts` before a reporter sees the config, so `filters` is empty and
  // the only evidence left is that a project's own globs name a file the run never collected.
  const written = await stampAfterRun(laneCtx(), laneSpecs().slice(0, 2));

  assert.ok(written);
  assert.equal(written.runSelection, 'files');
});

test('a name pattern, a shard, selected test ids, and a tag filter are each stamped by their own narrowing', async () => {
  const cases: readonly [Record<string, unknown>, string][] = [
    [{ testNamePattern: /a/ }, 'test-name'],
    [{ shard: { index: 1, count: 4 } }, 'shard'],
    [{ tagsFilter: ['@slow'] }, 'tags'],
  ];
  for (const [config, expected] of cases) {
    const written = await stampAfterRun(laneCtx({ config }), laneSpecs());

    assert.ok(written, expected);
    assert.equal(written.runSelection, expected, expected);
  }

  const collected = laneSpecs();
  collected[0] = { ...collected[0]!, testIds: ['1'] } as unknown as TestSpecification;
  const written = await stampAfterRun(laneCtx(), collected);

  assert.ok(written);
  assert.equal(written.runSelection, 'test-ids');
});

test('a run that did not forbid focused tests cannot claim the lane', async () => {
  // The one narrowing no module check can see: a focused case skips its siblings inside a file that is
  // still collected, so every evidence above still reads complete. `full` therefore requires the config to
  // say `allowOnly: false` rather than merely lacking a visible narrowing.
  for (const allowOnly of [undefined, true]) {
    const written = await stampAfterRun(laneCtx({ config: { allowOnly } }), laneSpecs());

    assert.ok(written, String(allowOnly));
    assert.equal(written.runSelection, 'unattested', String(allowOnly));
  }
});

test('the lane this reporter expects is the lane the coverage script runs', async () => {
  // Three facts the reporter depends on live outside it: which projects the config splits out of the
  // instrumented invocation, that those projects are real declared names, and the flag that makes a
  // focused run fail instead of stamping itself `full`. Each is compared against the source that owns it,
  // because each can go stale silently — rename the project, or drop the flag and a stray `test.only`
  // starts attesting a partial map as the whole lane.
  const root = path.resolve(import.meta.dirname, '..');
  const scripts = (
    JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')) as {
      scripts: Record<string, string>;
    }
  ).scripts;
  // The config itself, not its text: matching a project name as a substring would accept a renamed project
  // whose name still contains the token, or a comment, or any other string that mentions it.
  const { default: config } = (await import('../vitest.config.ts')) as {
    default: { test?: { projects?: Array<{ test?: { name?: string } }> } };
  };
  const declaredNames = (config.test?.projects ?? []).map((project) => project.test?.name ?? '');

  // The shipped constant, not a copy of it in this file: asserting a fixture against a fixture would let
  // the real declaration drift from both.
  for (const project of COVERAGE_UNINSTRUMENTED_PROJECTS) {
    assert.ok(
      declaredNames.includes(project),
      `vitest.config.ts keeps project '${project}' out of the coverage lane, which it no longer declares`,
    );
  }

  for (const lane of ['test:coverage', 'test:coverage:ci']) {
    const command = scripts[lane]!;
    // A lane with no `--project=!x` runs every project and needs no declaration, so the derived list is
    // simply empty there and the comparison below still decides.
    const excluded = [...command.matchAll(/--project=!(\S+)/g)].map((match) => match[1]!);
    assert.deepEqual(
      excluded,
      [...COVERAGE_UNINSTRUMENTED_PROJECTS],
      `${lane} and the project list vitest.config.ts hands the reporter disagree`,
    );
    // Without this, a focused case skips its siblings inside files that are still collected, so every
    // check in the reporter passes on a map that measured a fraction of the suite.
    assert.match(command, /--allowOnly=false/, `${lane} must refuse a focused run`);
  }
});
