// Tests for the gate-of-gates manifest (#1429).
//
// Almost every case here is synthetic, and deliberately so: the point of this gate is to catch
// shapes that do NOT exist in the repo yet — a renamed CI job, a deleted intermediate script, a
// new Vitest project nobody wired, a workflow trigger that excludes the paths its own gate
// owns. A test that could only assert today's tree would go green the moment the tree grew the
// hole. So each rule is exercised in its FAILING direction against a fixture, and the real tree
// appears only where the assertion is about the real tree (`pnpm check:gate-manifest` is the
// runner that does that job in full).

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { CHECK_CATALOG } from '../check-affected/checks.ts';
import {
  buildLanes,
  missingCatalogJobs,
  packageScriptSuite,
  parseWorkflow,
  pathFilterMatches,
  suiteUniverse,
  triggersOnPath,
  unownedTerminals,
  unreachableCatalogClaims,
  unreachablePathCategories,
  type CatalogEntry,
  type ResolveContext,
} from './model.ts';
import { vitestProjectNames } from './vitest-projects.ts';

const repoRoot = path.resolve(import.meta.dirname, '../..');

function context(overrides: Partial<ResolveContext> = {}): ResolveContext {
  return {
    packageScripts: new Map(),
    actions: new Map(),
    vitestProjects: ['unit-core', 'subprocess-stub'],
    expandTestPaths: (pattern) => [pattern],
    transparentWrappers: new Set(),
    declaredTerminals: new Map(),
    ...overrides,
  };
}

function lanesFor(workflows: Record<string, string>, ctx: ResolveContext) {
  return buildLanes(
    Object.entries(workflows).map(([file, source]) => parseWorkflow(file, source)),
    ctx,
  );
}

// --- Transitive execution, not string presence -------------------------------

test('a job owns the work at the far end of an aggregate script chain', () => {
  // `pnpm check:all` names neither the layering guard nor the suite; the graph has to walk two
  // hops to find them. "Does the workflow text mention check:layering?" would answer no.
  const ctx = context({
    packageScripts: new Map([
      ['check:all', 'pnpm check:layering && pnpm test:unit'],
      ['check:layering', 'node scripts/layering/check.ts'],
      ['test:unit', 'vitest run --project unit-core'],
    ]),
  });
  const [lane] = lanesFor(
    { 'ci.yml': 'jobs:\n  gate:\n    steps:\n      - run: pnpm check:all\n' },
    ctx,
  );
  assert.deepEqual([...lane!.terminals].sort(), [
    'exec:scripts/layering/check.ts',
    'vitest:unit-core',
  ]);
});

test('renaming an intermediate script breaks the chain instead of leaving a false claim', () => {
  // The workflow still says `pnpm check:all`, and `check:all` still says `pnpm check:layering`.
  // Only the leaf was renamed. A name-presence check stays green here; this must not.
  const ctx = context({
    packageScripts: new Map([
      ['check:all', 'pnpm check:layering && pnpm test:unit'],
      ['check:layering:renamed', 'node scripts/layering/check.ts'],
      ['test:unit', 'vitest run --project unit-core'],
    ]),
  });
  const [lane] = lanesFor(
    { 'ci.yml': 'jobs:\n  gate:\n    steps:\n      - run: pnpm check:all\n' },
    ctx,
  );
  assert.deepEqual(
    lane!.unresolved.map(({ kind, source }) => `${source} ${kind}`),
    ['ci.yml#gate missing-script'],
  );
  assert.ok(
    lane!.unresolved[0]!.detail.includes('pnpm check:layering'),
    'the failure must name the script that stopped existing',
  );
  assert.ok(!lane!.terminals.has('exec:scripts/layering/check.ts'));
});

test('an alias cycle stops re-expanding instead of recursing forever', () => {
  const ctx = context({
    packageScripts: new Map([
      ['a', 'pnpm b && node scripts/a.ts'],
      ['b', 'pnpm a && node scripts/b.ts'],
    ]),
  });
  const suite = packageScriptSuite('a', ctx.packageScripts.get('a')!, ctx);
  assert.deepEqual([...suite.terminals].sort(), ['exec:scripts/a.ts', 'exec:scripts/b.ts']);
});

// --- Local composite actions -------------------------------------------------

const BUILD_ACTION = `
name: 'Build'
inputs:
  build-command:
    default: 'pnpm build:default'
runs:
  using: 'composite'
  steps:
    - name: Build
      run: \${{ inputs.build-command }}
`;

test("a composite action's steps are walked, with inputs substituted from the caller", () => {
  // ci.yml's Swift job passes its real build command as an action input; without substitution
  // the whole Swift build lane looks unowned (and `${{ … }}` looks like dynamic dispatch).
  const ctx = context({
    actions: new Map([['.github/actions/build', BUILD_ACTION]]),
    packageScripts: new Map([['build:xcuitest:macos', 'sh ./scripts/build-xcuitest-apple.sh']]),
  });
  const [lane] = lanesFor(
    {
      'ci.yml':
        'jobs:\n  swift:\n    steps:\n      - uses: ./.github/actions/build\n' +
        '        with:\n          build-command: pnpm build:xcuitest:macos\n',
    },
    ctx,
  );
  assert.deepEqual([...lane!.terminals], ['exec:scripts/build-xcuitest-apple.sh']);
  assert.deepEqual(lane!.unresolved, []);
});

test("an action input the caller omits falls back to the action's declared default", () => {
  const ctx = context({
    actions: new Map([['.github/actions/build', BUILD_ACTION]]),
    packageScripts: new Map([['build:default', 'node scripts/build.ts']]),
  });
  const [lane] = lanesFor(
    { 'ci.yml': 'jobs:\n  swift:\n    steps:\n      - uses: ./.github/actions/build\n' },
    ctx,
  );
  assert.deepEqual([...lane!.terminals], ['exec:scripts/build.ts']);
});

test('a local action that does not exist fails closed', () => {
  const [lane] = lanesFor(
    { 'ci.yml': 'jobs:\n  gate:\n    steps:\n      - uses: ./.github/actions/gone\n' },
    context(),
  );
  assert.deepEqual(
    lane!.unresolved.map(({ kind, detail }) => `${kind}: ${detail}`),
    ['missing-action: local action "./.github/actions/gone" does not exist'],
  );
});

// --- Fail-closed on what cannot be read --------------------------------------

test('a dynamic command position is reported with its workflow, job, and step', () => {
  const [lane] = lanesFor(
    {
      'ci.yml':
        'jobs:\n  matrix:\n    steps:\n      - name: Run the matrix command\n' +
        '        run: ${{ matrix.command }}\n',
    },
    context(),
  );
  assert.deepEqual(
    lane!.unresolved.map(({ source, step, kind }) => ({ source, step, kind })),
    [{ source: 'ci.yml#matrix', step: 'Run the matrix command', kind: 'dynamic-command' }],
  );
});

test('an expression inside a command substitution is a value, not a dynamic command', () => {
  // `APP="$(find "${{ github.workspace }}/…")"` is an assignment. Reporting it as unresolved
  // dispatch would bury the real findings under noise from every fixture-locating step.
  const ctx = context({ packageScripts: new Map([['build', 'node scripts/build.ts']]) });
  const [lane] = lanesFor(
    {
      'ci.yml':
        'jobs:\n  gate:\n    steps:\n      - run: |\n' +
        '          APP="$(find "${{ github.workspace }}/.tmp" -name \'*.app\')"\n' +
        '          pnpm build\n',
    },
    ctx,
  );
  assert.deepEqual(lane!.unresolved, []);
  assert.deepEqual([...lane!.terminals], ['exec:scripts/build.ts']);
});

test('a script that resolves to no unit of work at all is reported, not silently owned', () => {
  const ctx = context({ packageScripts: new Map([['check:nothing', 'echo hello']]) });
  const suite = packageScriptSuite('check:nothing', 'echo hello', ctx);
  assert.deepEqual(
    suite.unresolved.map(({ kind }) => kind),
    ['no-terminal'],
  );
});

// --- Vitest projects ---------------------------------------------------------

test('an unfiltered vitest run owns every project; a filtered one owns only what it names', () => {
  const ctx = context({ vitestProjects: ['unit-core', 'subprocess-stub', 'output-economy'] });
  const lanes = lanesFor(
    {
      'ci.yml':
        'jobs:\n  all:\n    steps:\n      - run: pnpm exec vitest run --coverage\n' +
        '  some:\n    steps:\n      - run: pnpm exec vitest run --project unit-core\n',
    },
    ctx,
  );
  assert.deepEqual([...lanes[0]!.terminals].sort(), [
    'vitest:output-economy',
    'vitest:subprocess-stub',
    'vitest:unit-core',
  ]);
  assert.deepEqual([...lanes[1]!.terminals], ['vitest:unit-core']);
});

test('a new vitest project no lane runs is unowned until it is wired or waived', () => {
  const ctx = context({ vitestProjects: ['unit-core', 'brand-new'] });
  const lanes = lanesFor(
    {
      'ci.yml':
        'jobs:\n  cov:\n    steps:\n      - run: pnpm exec vitest run --project unit-core\n',
    },
    ctx,
  );
  const unowned = unownedTerminals(suiteUniverse(ctx), lanes, new Set());
  assert.deepEqual(unowned, [{ terminal: 'vitest:brand-new', suites: ['vitest:brand-new'] }]);
  // …and declaring it local-only silences exactly that one, nothing else.
  assert.deepEqual(unownedTerminals(suiteUniverse(ctx), lanes, new Set(['vitest:brand-new'])), []);
});

// --- Wrappers and opaque runners ---------------------------------------------

test('a transparent wrapper resolves to the test files it forwards, not to itself', () => {
  const ctx = context({
    transparentWrappers: new Set(['scripts/node-test-tmpdir.ts']),
    packageScripts: new Map([
      ['test:x', 'node scripts/node-test-tmpdir.ts --test test/a.test.ts test/b.test.ts'],
    ]),
  });
  const suite = packageScriptSuite('test:x', ctx.packageScripts.get('test:x')!, ctx);
  assert.deepEqual([...suite.terminals].sort(), [
    'node-test:test/a.test.ts',
    'node-test:test/b.test.ts',
  ]);
});

test('an opaque runner reaches only what its declared edge says it reaches', () => {
  const ctx = context({
    vitestProjects: ['unit-core', 'subprocess-stub'],
    declaredTerminals: new Map([['scripts/run.ts', ['vitest:unit-core']]]),
    packageScripts: new Map([['test:ci', 'node scripts/run.ts --coverage']]),
  });
  const suite = packageScriptSuite('test:ci', ctx.packageScripts.get('test:ci')!, ctx);
  assert.deepEqual([...suite.terminals].sort(), ['exec:scripts/run.ts', 'vitest:unit-core']);
  assert.ok(!suite.terminals.has('vitest:subprocess-stub'), 'a declared edge must not over-claim');
});

test('flags are dropped from a terminal but positional arguments are not', () => {
  // `test:replay:ios` and `test:replay:macos` both run src/bin.ts; only the positional
  // corpus path tells them apart, and a CI-only `--retries 2` must not split the terminal.
  const ctx = context({
    packageScripts: new Map([
      ['test:replay:ios', 'node src/bin.ts test test/replays/ios'],
      ['test:replay:macos', 'node src/bin.ts test test/replays/macos'],
    ]),
  });
  const ios = packageScriptSuite(
    'test:replay:ios',
    ctx.packageScripts.get('test:replay:ios')!,
    ctx,
  );
  const macos = packageScriptSuite(
    'test:replay:macos',
    ctx.packageScripts.get('test:replay:macos')!,
    ctx,
  );
  assert.deepEqual([...ios.terminals], ['exec:src/bin.ts test test/replays/ios']);
  assert.notDeepEqual([...ios.terminals], [...macos.terminals]);

  const [lane] = lanesFor(
    { 'macos.yml': 'jobs:\n  m:\n    steps:\n      - run: pnpm test:replay:macos --retries 2\n' },
    ctx,
  );
  assert.deepEqual([...lane!.terminals], [...macos.terminals]);
});

// --- CHECK_CATALOG.ciJobs ----------------------------------------------------

const CATALOG_WORKFLOWS = {
  '.github/workflows/ci.yml':
    'name: CI\non:\n  pull_request:\njobs:\n  lint:\n    name: Lint & Format\n' +
    '    steps:\n      - run: pnpm lint\n',
  '.github/workflows/ios.yml':
    'name: iOS\non:\n  pull_request:\njobs:\n  smoke:\n    name: Smoke Tests\n' +
    '    steps:\n      - run: pnpm build:xcuitest\n',
};

test('a catalog entry naming a job that no workflow defines fails, naming both sides', () => {
  const ctx = context({ packageScripts: new Map([['lint', 'oxlint .']]) });
  const lanes = lanesFor(CATALOG_WORKFLOWS, ctx);
  const catalog: CatalogEntry[] = [{ id: 'lint', script: 'lint', ciJobs: ['Lint and Format'] }];
  const [miss] = missingCatalogJobs(catalog, lanes);
  assert.equal(miss!.check, 'lint');
  assert.equal(miss!.job, 'Lint and Format');
  assert.ok(miss!.known.includes('Lint & Format'), 'the message must offer the real job names');
});

test('a cross-workflow job is matched bare and as "<workflow> / <job>"', () => {
  const ctx = context({ packageScripts: new Map([['build:xcuitest', 'sh ./scripts/x.sh']]) });
  const lanes = lanesFor(CATALOG_WORKFLOWS, ctx);
  assert.deepEqual(
    missingCatalogJobs([{ id: 'swift', script: null, ciJobs: ['iOS / Smoke Tests'] }], lanes),
    [],
  );
  assert.deepEqual(
    missingCatalogJobs([{ id: 'swift', script: null, ciJobs: ['tvOS / Smoke Tests'] }], lanes)
      .length,
    1,
  );
});

test('a matrix job whose name interpolates claims no check name rather than a literal one', () => {
  const lanes = lanesFor(
    {
      'm.yml':
        'name: M\non:\n  pull_request:\njobs:\n  shard:\n    name: Mutants (${{ matrix.name }})\n' +
        '    steps:\n      - run: pnpm mutation:run\n',
    },
    context({ packageScripts: new Map([['mutation:run', 'node scripts/mutation/run.ts']]) }),
  );
  assert.deepEqual(lanes[0]!.checkNames, []);
});

test('a catalog claim is judged against the union of the jobs it names, not each alone', () => {
  // `unit` legitimately names two jobs that split the work between them; neither runs all of it.
  const ctx = context({
    packageScripts: new Map([
      ['check:unit', 'pnpm test:unit && pnpm test:smoke'],
      ['test:unit', 'vitest run --project unit-core'],
      ['test:smoke', 'node scripts/smoke.ts'],
    ]),
  });
  const lanes = lanesFor(
    {
      'ci.yml':
        'name: CI\non:\n  pull_request:\njobs:\n  cov:\n    name: Coverage\n' +
        '    steps:\n      - run: pnpm test:unit\n' +
        '  int:\n    name: Integration Tests\n    steps:\n      - run: pnpm test:smoke\n',
    },
    ctx,
  );
  const catalog: CatalogEntry[] = [
    { id: 'unit', script: 'check:unit', ciJobs: ['Coverage', 'Integration Tests'] },
  ];
  assert.deepEqual(unreachableCatalogClaims(catalog, lanes, ctx, new Set()), []);

  // Drop one of the two jobs from the claim and the uncovered half surfaces by name.
  const [miss] = unreachableCatalogClaims(
    [{ id: 'unit', script: 'check:unit', ciJobs: ['Coverage'] }],
    lanes,
    ctx,
    new Set(),
  );
  assert.deepEqual(miss!.missing, ['exec:scripts/smoke.ts']);
});

// --- Path-category reachability (the #1420 shape) ----------------------------

test('workflow path filters match GitHub glob semantics', () => {
  assert.ok(pathFilterMatches('website/**', 'website/docs/commands.md'));
  assert.ok(pathFilterMatches('docs/**', 'docs/agents/testing.md'));
  assert.ok(!pathFilterMatches('website/**', 'src/website.ts'));
  assert.ok(pathFilterMatches('*.md', 'README.md'));
  assert.ok(!pathFilterMatches('*.md', 'docs/a.md'), '`*` must not cross a slash');
  assert.ok(pathFilterMatches('**/*.md', 'docs/a.md'));
  assert.ok(pathFilterMatches('README.md', 'README.md'));
});

test('paths-ignore excludes a path; an allowlisting paths: filter restricts to its own list', () => {
  const ignore = parseWorkflow(
    'ci.yml',
    "on:\n  pull_request:\n    paths-ignore:\n      - 'website/**'\njobs: {}\n",
  ).triggers;
  assert.ok(!triggersOnPath(ignore, 'website/docs/commands.md'));
  assert.ok(triggersOnPath(ignore, 'src/cli.ts'));

  const allow = parseWorkflow(
    'preview.yml',
    "on:\n  pull_request:\n    paths:\n      - 'website/**'\njobs: {}\n",
  ).triggers;
  assert.ok(allow && triggersOnPath(allow, 'website/docs/commands.md'));
  assert.ok(!triggersOnPath(allow, 'src/cli.ts'));
});

test('a category whose owning job is excluded by its own workflow trigger fails', () => {
  // The generalized #1420 hole: the gate exists, the job exists, and the job never fires for
  // the change it is supposed to gate.
  const ctx = context({ packageScripts: new Map([['check:docs', 'node scripts/docs.ts']]) });
  const workflows = [
    parseWorkflow(
      '.github/workflows/ci.yml',
      "name: CI\non:\n  pull_request:\n    paths-ignore:\n      - 'website/**'\n" +
        'jobs:\n  docs:\n    name: Docs Gate\n    steps:\n      - run: pnpm check:docs\n',
    ),
  ];
  const lanes = buildLanes(workflows, ctx);
  const catalog: CatalogEntry[] = [{ id: 'docs', script: 'check:docs', ciJobs: ['Docs Gate'] }];
  const misses = unreachablePathCategories(
    [{ label: 'website docs', path: 'website/docs/commands.md', checks: ['docs'] }],
    catalog,
    workflows,
    lanes,
    new Set(),
  );
  assert.deepEqual(misses, [
    {
      category: 'website docs',
      path: 'website/docs/commands.md',
      check: 'docs',
      job: 'Docs Gate',
      workflow: '.github/workflows/ci.yml',
    },
  ]);
  // A path the workflow does trigger on is reachable through the same job.
  assert.deepEqual(
    unreachablePathCategories(
      [{ label: 'source', path: 'src/cli.ts', checks: ['docs'] }],
      catalog,
      workflows,
      lanes,
      new Set(),
    ),
    [],
  );
});

// --- The Vitest project universe --------------------------------------------

test("the repo's own vitest.config.ts yields exactly its declared projects", () => {
  const source = fs.readFileSync(path.join(repoRoot, 'vitest.config.ts'), 'utf8');
  assert.deepEqual(vitestProjectNames('vitest.config.ts', source), [
    'interaction-contract',
    'output-economy',
    'provider-integration',
    'subprocess-stub',
    'unit-core',
  ]);
});

test('a config the parser cannot find projects in throws rather than reporting none', () => {
  // Returning [] here would mean "no projects to own", i.e. the gate quietly passing — the
  // exact failure mode this whole module exists to prevent.
  assert.throws(
    () => vitestProjectNames('vitest.config.ts', 'export default { test: { name: "solo" } };'),
    /Could not find a `projects: \[\.\.\.\]` array/,
  );
});

test('only names inside the projects array count as projects', () => {
  const config = `export default defineConfig({
    test: {
      name: 'not-a-project',
      projects: [{ test: { name: 'unit-core' } }, { test: { name: 'e2e' } }],
      coverage: { name: 'also-not-a-project' },
    },
  });`;
  assert.deepEqual(vitestProjectNames('vitest.config.ts', config), ['e2e', 'unit-core']);
});

// --- The real tree ----------------------------------------------------------

test('every CHECK_CATALOG.ciJobs entry names a job that really exists', () => {
  // The #1429 primary hole, asserted against the live workflows so a job rename fails in the
  // unit lane too and not only in `pnpm check:gate-manifest`.
  const files = execFileSync('git', ['ls-files', '.github/workflows/*.yml'], {
    cwd: repoRoot,
    encoding: 'utf8',
  })
    .split('\n')
    .filter(Boolean);
  const workflows = files.map((file) =>
    parseWorkflow(file, fs.readFileSync(path.join(repoRoot, file), 'utf8')),
  );
  const lanes = buildLanes(workflows, context());
  const catalog: CatalogEntry[] = CHECK_CATALOG.map((entry) => ({
    id: entry.id,
    script: entry.kind.type === 'script' ? entry.kind.script : null,
    ciJobs: entry.ciJobs,
  }));
  assert.deepEqual(
    missingCatalogJobs(catalog, lanes).map((miss) => `${miss.check} → "${miss.job}"`),
    [],
    'a CHECK_CATALOG entry points at a CI job no workflow defines',
  );
});
