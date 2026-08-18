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
    packageEntryFiles: ['src/index.ts', 'packages/selectors/src/index.ts'],
    ...extra,
  });
}

function ids(changedFiles: string[]): CheckId[] {
  return plan(changedFiles).checks;
}

test('production source selects static/build gates and delegates tests to Vitest', () => {
  const result = plan(['packages/selectors/src/index.ts']);
  assert.equal(result.failOpen, false);
  for (const id of [
    'format',
    'lint',
    'typecheck',
    'layering',
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

test('Swift runner change selects both XCUITest platform builds', () => {
  // Each platform build is its own gate in its own lane, so a Swift change owns both.
  // (The Apple device lanes ride along: the runner is what those lanes boot — device-lanes.ts.)
  assert.deepEqual(ids(['apple/runner/Sources/Runner/Main.swift']), [
    'swift-runner-ios',
    'swift-runner-macos',
    'replay-ios',
    'replay-ios-device',
    'replay-macos',
  ]);
  assert.ok(ids(['src/platforms/apple/core/runner/Support.swift']).includes('swift-runner-ios'));
});

test('a runner XCTest source also selects the test-list and package-source check', () => {
  // Distinct from the rule above, which owns Swift *anywhere*: renaming a method under
  // AgentDeviceRunnerUITests/ silently shrinks ios.yml's hand-written `-only-testing:` list
  // (#1781 A7), and the platform builds cannot see that — they compile fine either way.
  assert.deepEqual(
    ids(['apple/runner/AgentDeviceRunner/AgentDeviceRunnerUITests/RunnerTests+Alert.swift']),
    [
      'swift-runner-ios',
      'swift-runner-macos',
      'xctest-selection',
      'replay-ios',
      'replay-ios-device',
      'replay-macos',
    ],
  );
  // The bug the file filter used to have: membership is the directory, not the name.
  assert.ok(
    ids([
      'apple/runner/AgentDeviceRunner/AgentDeviceRunnerUITests/RunnerTapPointPolicy.swift',
    ]).includes('xctest-selection'),
  );
  // Swift elsewhere in the runner still selects only the builds.
  assert.ok(!ids(['apple/runner/Sources/Runner/Main.swift']).includes('xctest-selection'));
});

test('Android helper change selects the android-helpers build', () => {
  assert.deepEqual(ids(['android/snapshot-helper/src/Main.kt']), [
    'android-helpers',
    'replay-android',
  ]);
  assert.deepEqual(ids(['android/ime-helper/AndroidManifest.xml']), [
    'android-helpers',
    'replay-android',
  ]);
});

test('MCP metadata change selects the mcp-metadata check', () => {
  assert.deepEqual(ids(['server.json']), ['mcp-metadata']);
});

test('public package surface change selects the build and the published-package gate via exports', () => {
  const result = ids(['src/index.ts']);
  assert.ok(result.includes('build'));
  // A public entry is the one surface a consumer resolves by name, so building it is not enough:
  // check:package proves it still imports from an install with no workspace links.
  assert.ok(result.includes('package'));
  assert.ok(ids(['packages/selectors/src/index.ts']).includes('package'));
});

test('docs-only change selects no checks and records the docs paths', () => {
  const result = plan(['docs/adr/0011.md', 'README.md', 'website/page.mdx.md']);
  assert.equal(result.failOpen, false);
  assert.deepEqual(result.checks, []);
  assert.equal(result.docsOnlyPaths.length, 3);
});

test('test app source selects root lint and format plus its isolated typecheck', () => {
  const result = plan(['examples/test-app/app/index.tsx']);
  assert.equal(result.failOpen, false);
  // Plus the mobile lanes that install the fixture app it builds (device-lanes.ts).
  assert.deepEqual(result.checks, [
    'format',
    'lint',
    'test-app-typecheck',
    'replay-ios',
    'replay-ios-device',
    'replay-android',
  ]);
});

test('unknown path fails open to the full check set', () => {
  const result = plan(['fixtures/unknown.data']);
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

test('a frozen replay-compat corpus script selects the unit lane and the provenance verifier', () => {
  const result = plan(['test/replay-compat/scripts/examples/gesture-lab.v0.16.8.ad']);
  assert.equal(result.failOpen, false);
  assert.ok(result.checks.includes('unit'));
  assert.ok(result.checks.includes('replay-compat'));
});

test('a replay-compat manifest edit selects the provenance verifier', () => {
  const result = plan(['test/replay-compat/manifest.ts']);
  assert.equal(result.failOpen, false);
  assert.ok(result.checks.includes('replay-compat'));
});

test('skills guidance change is docs-only', () => {
  const result = plan(['skills/agent-device/SKILL.md']);
  assert.equal(result.failOpen, false);
  assert.deepEqual(result.docsOnlyPaths, ['skills/agent-device/SKILL.md']);
  assert.deepEqual(result.checks, []);
});

test('workspace package source selects static gates, fallow, layering, and the build', () => {
  for (const file of [
    'packages/kernel/src/errors.ts',
    'packages/contracts/src/facades/device.ts',
    'packages/capture-kit/src/app-log-live-handle.ts',
  ]) {
    const result = plan([file]);
    assert.equal(result.failOpen, false, file);
    for (const id of [
      'format',
      'lint',
      'typecheck',
      // Package source is inside fallow's scope; an extraction into packages/
      // must not take a symbol's dead-code coverage with it.
      'fallow',
      'layering',
      'build',
      'vitest-related',
    ] as const) {
      assert.ok(result.checks.includes(id), `expected ${id} for ${file}`);
    }
  }
});

test('a workspace package manifest fails open — it rewires resolution globally', () => {
  const result = plan(['packages/kernel/package.json']);
  assert.equal(result.failOpen, true);
  assert.equal(result.failOpenReasons[0]?.rule, 'workflow-tooling');
});

test('workflow/tooling and selector-owning changes fail open', () => {
  assert.equal(plan(['.github/workflows/ci.yml']).failOpenReasons[0]?.rule, 'workflow-tooling');
  assert.equal(plan(['package.json']).failOpenReasons[0]?.rule, 'workflow-tooling');
  assert.equal(plan(['vitest.config.ts']).failOpenReasons[0]?.rule, 'workflow-tooling');
  assert.equal(
    plan(['scripts/check-affected/model.ts']).failOpenReasons[0]?.rule,
    'selector-owning',
  );
  // The Testing Matrix lives here; a matrix edit must outrank the docs-only
  // short-circuit that its `docs/` path would otherwise take.
  assert.equal(plan(['docs/agents/testing.md']).failOpenReasons[0]?.rule, 'selector-owning');
});

test('a fail-open path in a mixed changeset forces the full set', () => {
  const result = plan(['packages/selectors/src/index.ts', 'bin/agent-device.mjs']);
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

test('every catalog command resolves against the real package scripts', () => {
  // Against package.json rather than a fixture map: a fixture has to be updated by
  // hand for every new gate, which is exactly the drift the registry exists to stop.
  const scripts = (
    JSON.parse(fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf8')) as {
      scripts: Record<string, string>;
    }
  ).scripts;
  for (const spec of CHECK_CATALOG) {
    assert.ok(resolveCommand(spec, scripts, 'origin/main').length >= 2, `${spec.id} must resolve`);
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

test('unit and coverage checks preserve their package-script owners', () => {
  const scripts = { 'check:unit': 'x', 'check:coverage-changed': 'x' };
  const unit = CHECK_CATALOG.find((entry) => entry.id === 'unit')!;
  const coverage = CHECK_CATALOG.find((entry) => entry.id === 'coverage')!;
  assert.deepEqual(resolveCommand(unit, scripts, 'origin/main'), ['pnpm', 'run', 'check:unit']);
  assert.deepEqual(resolveCommand(coverage, scripts, 'origin/main'), [
    'pnpm',
    'run',
    'check:coverage-changed',
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
