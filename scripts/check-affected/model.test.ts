import assert from 'node:assert/strict';
import { test } from 'node:test';
import { assertCatalogComplete, CHECK_CATALOG, resolveCommand } from './checks.ts';
import {
  ALL_CHECKS,
  globToRegExp,
  selectChecks,
  type CheckId,
  type SelectInput,
  type VitestProject,
} from './model.ts';

// Mirrors the real vitest.config.ts projects so tests exercise the same
// include/exclude ownership the runner loads at runtime.
const VITEST_PROJECTS: VitestProject[] = [
  {
    name: 'unit-core',
    include: ['src/**/*.test.ts', 'scripts/__tests__/help-conformance-bench.test.ts'],
    exclude: [
      'src/platforms/android/__tests__/{app-lifecycle-install,app-lifecycle-open,device-input-state,input-actions,notifications,settings}.test.ts',
    ],
  },
  {
    name: 'android-adb',
    include: [
      'src/platforms/android/__tests__/{app-lifecycle-install,app-lifecycle-open,device-input-state,input-actions,notifications,settings}.test.ts',
    ],
  },
  { name: 'provider-integration', include: ['test/integration/provider-scenarios/**/*.test.ts'] },
  { name: 'interaction-contract', include: ['test/integration/interaction-contract/**/*.test.ts'] },
  { name: 'output-economy', include: ['test/output-economy/**/*.test.ts'] },
];

function plan(changedFiles: string[], extra: Partial<SelectInput> = {}) {
  return selectChecks({
    changedFiles,
    vitestProjects: VITEST_PROJECTS,
    packageEntryFiles: ['src/index.ts', 'src/selectors.ts'],
    ...extra,
  });
}

function ids(changedFiles: string[]): CheckId[] {
  return plan(changedFiles).checks;
}

test('glob matcher handles **, *, ?, and brace groups like the vitest config', () => {
  assert.ok(globToRegExp('src/**/*.test.ts').test('src/a/b/c.test.ts'));
  assert.ok(globToRegExp('src/**/*.test.ts').test('src/a.test.ts'));
  assert.ok(!globToRegExp('src/**/*.test.ts').test('src/a.ts'));
  assert.ok(globToRegExp('test/output-economy/**/*.test.ts').test('test/output-economy/x.test.ts'));
  assert.ok(
    globToRegExp('src/platforms/android/__tests__/{notifications,settings}.test.ts').test(
      'src/platforms/android/__tests__/settings.test.ts',
    ),
  );
  assert.ok(!globToRegExp('a/*.ts').test('a/b/c.ts'));
});

test('production source change selects gates + build + unit, with reasons', () => {
  const result = plan(['src/daemon/selectors.ts']);
  assert.equal(result.failOpen, false);
  for (const id of [
    'format',
    'lint',
    'typecheck',
    'layering',
    'fallow',
    'build',
    'unit',
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
  assert.ok(result.includes('unit'));
});

test('unit test file selects only the unit suite (+ gates), not integration projects', () => {
  const result = ids(['src/daemon/selectors.test.ts']);
  assert.ok(result.includes('unit'));
  assert.ok(!result.includes('provider-integration'));
  assert.ok(!result.includes('output-economy'));
});

test('vitest project ownership routes each integration test to its project', () => {
  assert.ok(
    ids(['test/integration/provider-scenarios/foo.test.ts']).includes('provider-integration'),
  );
  assert.ok(
    ids(['test/integration/interaction-contract/bar.test.ts']).includes('interaction-contract'),
  );
  assert.ok(ids(['test/output-economy/baz.test.ts']).includes('output-economy'));
});

test('android-adb stub test routes to the unit suite via its own project', () => {
  const result = ids(['src/platforms/android/__tests__/notifications.test.ts']);
  assert.ok(result.includes('unit'));
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

test('workflow/tooling and selector-owning changes fail open', () => {
  assert.equal(plan(['.github/workflows/ci.yml']).failOpenReasons[0]?.rule, 'workflow-tooling');
  assert.equal(plan(['package.json']).failOpenReasons[0]?.rule, 'workflow-tooling');
  assert.equal(plan(['vitest.config.ts']).failOpenReasons[0]?.rule, 'workflow-tooling');
  assert.equal(
    plan(['scripts/check-affected/model.ts']).failOpenReasons[0]?.rule,
    'selector-owning',
  );
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
    'test:unit': 'x',
    'test:output-economy': 'x',
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
