import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { assertCatalogComplete, CHECK_CATALOG, resolveCommand } from './checks.ts';
import { ALL_CHECKS, selectChecks, type CheckId, type SelectInput } from './model.ts';

function plan(changedFiles: string[], extra: Partial<SelectInput> = {}) {
  return selectChecks({
    changedFiles,
    packageEntryFiles: ['src/index.ts', 'src/selectors.ts'],
    ...extra,
  });
}

function ids(changedFiles: string[]): CheckId[] {
  return plan(changedFiles).checks;
}

test('production source selects static/build gates and delegates tests to Vitest', () => {
  const result = plan(['src/daemon/selectors.ts']);
  assert.equal(result.failOpen, false);
  for (const id of [
    'format',
    'lint',
    'typecheck',
    'layering',
    'fallow',
    'build',
    'vitest-related',
  ] as const) {
    assert.ok(result.checks.includes(id), `expected ${id}`);
  }
  assert.ok(!result.checks.includes('provider-integration'));
  // Every selected check documents why it was chosen.
  for (const id of result.checks) {
    assert.ok(result.reasons.some((reason) => reason.check === id));
  }
});

test('platform source additionally selects provider-integration', () => {
  const result = ids(['src/platforms/apple/core/apps.ts']);
  assert.ok(result.includes('provider-integration'));
  assert.ok(result.includes('coverage'));
  assert.ok(result.includes('vitest-related'));
});

test('unit test files delegate affected-test discovery to Vitest', () => {
  const result = ids(['src/daemon/selectors.test.ts']);
  assert.ok(result.includes('vitest-related'));
  assert.ok(!result.includes('unit'));
  assert.ok(!result.includes('provider-integration'));
});

test('Vitest owns project and support-module relationships through one check', () => {
  for (const file of [
    'test/integration/provider-scenarios/foo.test.ts',
    'test/integration/provider-scenarios/fixtures.ts',
    'test/integration/interaction-contract/fixtures.ts',
    'test/output-economy/fixtures.ts',
    'src/__tests__/test-utils/session.ts',
  ]) {
    assert.ok(ids([file]).includes('vitest-related'), `expected Vitest ownership for ${file}`);
  }
});

test('root node-integration support modules select the node integration suite', () => {
  assert.ok(ids(['test/integration/test-helpers.ts']).includes('integration-node'));
});

test('android-adb stub test delegates project ownership to Vitest', () => {
  const result = ids(['src/platforms/android/__tests__/notifications.test.ts']);
  assert.ok(result.includes('vitest-related'));
});

test('Swift runner change selects the swift-runner build', () => {
  assert.deepEqual(ids(['apple-runner/Sources/Runner/Main.swift']), ['swift-runner']);
  assert.ok(ids(['src/platforms/apple/core/runner/Support.swift']).includes('swift-runner'));
});

test('Android helper change selects the android-helpers build', () => {
  assert.deepEqual(ids(['android-snapshot-helper/src/Main.kt']), ['android-helpers']);
  assert.deepEqual(ids(['android-multitouch-helper/build.gradle']), ['android-helpers']);
});

test('MCP metadata change selects the mcp-metadata check', () => {
  assert.deepEqual(ids(['server.json']), ['mcp-metadata']);
});

test('public package surface change selects the build via exports', () => {
  const result = ids(['src/index.ts']);
  assert.ok(result.includes('build'));
});

test('docs-only change selects no checks and records the docs paths', () => {
  const result = plan(['docs/adr/0011.md', 'README.md', 'website/page.mdx.md']);
  assert.equal(result.failOpen, false);
  assert.deepEqual(result.checks, []);
  assert.equal(result.docsOnlyPaths.length, 3);
});

test('unknown path fails open to the full check set', () => {
  const result = plan(['examples/test-app/App.tsx']);
  assert.equal(result.failOpen, true);
  assert.deepEqual(result.checks, [...ALL_CHECKS]);
  assert.equal(result.failOpenReasons[0]?.rule, 'unknown-path');
});

test('a non-.ts fixture under an owned root fails open (format alone is not ownership)', () => {
  const result = plan(['test/integration/provider-scenarios/fixtures/device.json']);
  assert.equal(result.failOpen, true);
  assert.deepEqual(result.checks, [...ALL_CHECKS]);
  assert.equal(result.failOpenReasons[0]?.rule, 'ambiguous-path');
});

test('skills guidance change selects format + skillgym, not docs-only', () => {
  const result = plan(['skills/agent-device/SKILL.md']);
  assert.equal(result.failOpen, false);
  assert.equal(result.docsOnlyPaths.length, 0);
  assert.ok(result.checks.includes('skillgym'), 'skills change must select the SkillGym suite');
  assert.ok(result.checks.includes('format'), 'skills change must still run format');
});

test('SkillGym harness change selects the skillgym suite', () => {
  const result = ids(['test/skillgym/suites/agent-device-smoke-suite.ts']);
  assert.ok(result.includes('skillgym'));
});

test('workflow/tooling and selector-owning changes fail open', () => {
  assert.equal(plan(['.github/workflows/ci.yml']).failOpenReasons[0]?.rule, 'workflow-tooling');
  assert.equal(plan(['package.json']).failOpenReasons[0]?.rule, 'workflow-tooling');
  assert.equal(plan(['vitest.config.ts']).failOpenReasons[0]?.rule, 'workflow-tooling');
  assert.equal(
    plan(['scripts/check-affected/model.ts']).failOpenReasons[0]?.rule,
    'selector-owning',
  );
  assert.equal(plan(['AGENTS.md']).failOpenReasons[0]?.rule, 'selector-owning');
});

test('a fail-open path in a mixed changeset forces the full set', () => {
  const result = plan(['src/daemon/selectors.ts', 'bin/agent-device.mjs']);
  assert.equal(result.failOpen, true);
  assert.deepEqual(result.checks, [...ALL_CHECKS]);
});

test('empty changeset selects nothing', () => {
  const result = plan([]);
  assert.equal(result.failOpen, false);
  assert.deepEqual(result.checks, []);
});

test('catalog covers exactly the CheckId universe', () => {
  assert.doesNotThrow(assertCatalogComplete);
});

test('every catalog command resolves against package scripts', () => {
  const scripts: Record<string, string> = {
    'format:check': 'x',
    lint: 'x',
    typecheck: 'x',
    'check:layering': 'x',
    'check:fallow': 'x',
    'check:mcp-metadata': 'x',
    build: 'x',
    'check:unit': 'x',
    'test:coverage': 'x',
    'test:integration:provider': 'x',
    'test:integration:node': 'x',
    'test:integration:progress:check': 'x',
    'build:xcuitest': 'x',
    'build:android-snapshot-helper': 'x',
    'build:macos-helper': 'x',
    'test:smoke:web': 'x',
    'test:skillgym': 'x',
  };
  for (const spec of CHECK_CATALOG) {
    const command = resolveCommand(spec, scripts, 'origin/main');
    assert.ok(command.length >= 2);
  }
  const fallow = CHECK_CATALOG.find((spec) => spec.id === 'fallow')!;
  assert.deepEqual(resolveCommand(fallow, scripts, 'origin/dev'), [
    'pnpm',
    'run',
    'check:fallow',
    '--base',
    'origin/dev',
  ]);
});

test('a missing package script makes command resolution throw', () => {
  const spec = CHECK_CATALOG.find((entry) => entry.id === 'lint')!;
  assert.throws(() => resolveCommand(spec, {}, 'origin/main'), /does not exist/);
});

test('unit and coverage checks preserve the Testing Matrix aggregates', () => {
  const scripts = { 'check:unit': 'x', 'test:coverage': 'x' };
  const unit = CHECK_CATALOG.find((entry) => entry.id === 'unit')!;
  const coverage = CHECK_CATALOG.find((entry) => entry.id === 'coverage')!;
  assert.deepEqual(resolveCommand(unit, scripts, 'origin/main'), ['pnpm', 'run', 'check:unit']);
  assert.deepEqual(resolveCommand(coverage, scripts, 'origin/main'), [
    'pnpm',
    'run',
    'test:coverage',
  ]);
});

test('vitest-related delegates changed paths to Vitest instead of modeling projects', () => {
  const related = CHECK_CATALOG.find((entry) => entry.id === 'vitest-related')!;
  assert.deepEqual(resolveCommand(related, {}, 'origin/main', ['src/a.ts', 'test/fixture.ts']), [
    'pnpm',
    'exec',
    'vitest',
    'related',
    '--run',
    '--passWithNoTests',
    'src/a.ts',
    'test/fixture.ts',
  ]);
});

// Guards the catalog against reality, not fixtures: the self-test above uses a
// hand-built scripts map, so this resolves every catalog entry against the real
// package.json. A renamed/removed script fails here instead of
// leaving `pnpm check:affected` broken on the exact command the docs advertise.
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

test('catalog resolves against the real package.json', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf8')) as {
    scripts?: Record<string, string>;
  };
  const scripts = pkg.scripts ?? {};
  for (const spec of CHECK_CATALOG) {
    assert.doesNotThrow(
      () => resolveCommand(spec, scripts, 'origin/main'),
      `catalog entry "${spec.id}" must resolve against the real package.json`,
    );
  }
});

test('every catalog CI job maps to a real workflow job (no fabricated checks)', () => {
  const workflowsDir = path.join(repoRoot, '.github', 'workflows');
  const workflows = fs
    .readdirSync(workflowsDir)
    .filter((file) => file.endsWith('.yml') || file.endsWith('.yaml'))
    .map((file) => fs.readFileSync(path.join(workflowsDir, file), 'utf8'))
    .join('\n');
  for (const spec of CHECK_CATALOG) {
    for (const job of spec.ciJobs) {
      // GitHub renders check names as "<workflow> / <job>"; match on the job.
      const jobName = job.includes(' / ') ? job.slice(job.lastIndexOf(' / ') + 3) : job;
      assert.ok(
        workflows.includes(`name: ${jobName}`),
        `catalog check "${spec.id}" references CI job "${job}", but no workflow defines "${jobName}"`,
      );
    }
  }
});

test('skillgym is a local-only gate (locally runnable, claims no CI job)', () => {
  const skillgym = CHECK_CATALOG.find((spec) => spec.id === 'skillgym')!;
  assert.equal(skillgym.localRunnable, true);
  assert.deepEqual([...skillgym.ciJobs], []);
});
