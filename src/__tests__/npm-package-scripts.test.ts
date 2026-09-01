import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'vitest';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const packageJson = JSON.parse(fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf8')) as {
  scripts: Record<string, string>;
};
const perfNightlyWorkflow = fs.readFileSync(
  path.join(repoRoot, '.github', 'workflows', 'perf-nightly.yml'),
  'utf8',
);
const packagedCliWorkflow = fs.readFileSync(
  path.join(repoRoot, '.github', 'workflows', 'ci.yml'),
  'utf8',
);
const mcpRegistryWorkflow = fs.readFileSync(
  path.join(repoRoot, '.github', 'workflows', 'publish-mcp-registry.yml'),
  'utf8',
);

function script(name: string): string {
  const value = packageJson.scripts[name];
  assert.ok(value, `package.json must define "${name}"`);
  return value;
}

test('prepack builds the complete package without stopping the development daemon', () => {
  assert.equal(script('prepack'), 'pnpm check:mcp-metadata && pnpm package:npm');
  assert.doesNotMatch(script('package:npm'), /clean:daemon|rebuild:cli/);
  assert.equal(packageJson.scripts['build:dev'], undefined);
});

test('perf uses one platform-selectable entry point', () => {
  assert.equal(script('perf'), 'node --experimental-strip-types scripts/perf/run.ts');
  assert.equal(packageJson.scripts['perf:ios'], undefined);
  assert.equal(packageJson.scripts['perf:android'], undefined);
  assert.doesNotMatch(perfNightlyWorkflow, /pnpm perf:/);
  assert.match(perfNightlyWorkflow, /pnpm perf --platform ios/);
  assert.match(perfNightlyWorkflow, /pnpm perf --platform android/);
});

test('Fallow exposes one changed-code gate and an explicit full-tree audit', () => {
  assert.equal(packageJson.scripts.fallow, undefined);
  assert.equal(script('check:fallow'), 'fallow audit');
  assert.equal(script('fallow:all'), 'fallow --summary');
});

// `check:package` verifies the tarball, so it has to observe every build output the package ships.
// Keep construction separate from verification so release preparation can publish the exact tarball
// that was installed and smoke-tested instead of rebuilding it during `npm publish`.
test('the npm package build covers every package-owned output before verification', () => {
  assert.deepEqual(script('build:package').split(' && '), [
    'pnpm build',
    'pnpm build:xcuitest:ios',
    'pnpm build:xcuitest:macos',
    'pnpm build:xcuitest:tvos',
    'pnpm build:xcuitest:visionos',
    'pnpm build:macos-helper:clean',
    'pnpm prepare:publish-assets',
  ]);
  assert.equal(script('prepare:publish-assets'), 'node scripts/prepare-publish-assets.mjs');
  assert.equal(script('package:npm'), 'pnpm build:package && pnpm check:package');

  assert.deepEqual(script('build:android').split(' && '), [
    'pnpm package:android-snapshot-helper:npm',
    'pnpm package:android-ime-helper:npm',
  ]);
});

test('release publishing uploads the tarball that passed the package gate', () => {
  assert.equal(
    script('release:prepare'),
    'node scripts/release-mark-dev.mjs --check-release-version && rm -rf .tmp/release && pnpm check:mcp-metadata && pnpm build:package && pnpm check:package -- --pack-destination .tmp/release',
  );
  assert.equal(
    script('release:publish'),
    'pnpm release:prepare && npm publish --ignore-scripts .tmp/release/*.tgz && pnpm release:mark-dev',
  );
  assert.doesNotMatch(script('release:publish'), /prepack|package:npm/);
});

// AS-012: registry scanners diff the repository's tool surface per version string, so the
// version on main must never equal a published version. Publishing marks main as unreleased
// (`-dev` prerelease on the next patch) right after the upload, and preparation refuses to
// publish while that marker is still in place.
test('release publishing moves main off the released version', () => {
  assert.match(
    script('release:prepare'),
    /^node scripts\/release-mark-dev\.mjs --check-release-version && /,
  );
  assert.match(script('release:publish'), / && pnpm release:mark-dev$/);
  assert.equal(script('release:mark-dev'), 'node scripts/release-mark-dev.mjs');
});

test('the package checker can retain the tarball it verifies for publishing', () => {
  const gate = fs.readFileSync(path.join(repoRoot, 'scripts', 'check-package.ts'), 'utf8');
  assert.match(gate, /--pack-destination/);
  assert.match(gate, /packDestination/);
  assert.match(gate, /fs\.mkdirSync\(packDestination, \{ recursive: true \}\)/);
  assert.match(gate, /fs\.rmSync\(workDir, \{ recursive: true, force: true \}\)/);
});

test('the package gate runs the closure audit and both runtime probes', () => {
  const gate = fs.readFileSync(path.join(repoRoot, 'scripts', 'check-package.ts'), 'utf8');
  for (const call of [
    'auditDependencyClosure(installedRoot, manifest)',
    'importEveryExport(manifest)',
    'smokeTestBin(installedRoot, manifest)',
  ]) {
    assert.ok(gate.includes(call), `scripts/check-package.ts must still call ${call}`);
  }
});

test('the package gate disables the detached update notifier for its smoke probes', () => {
  const gate = fs.readFileSync(path.join(repoRoot, 'scripts', 'check-package.ts'), 'utf8');
  assert.match(gate, /env: \{ \.\.\.process\.env, AGENT_DEVICE_NO_UPDATE_NOTIFIER: '1' \}/);
});

// The gate reads the packed tarball, so `prepack` is the last point where a broken package can still
// be stopped. Publishing runs it; nothing else guarantees the tarball is ever verified.
test('publishing cannot skip the package gate', () => {
  assert.match(script('package:npm'), /pnpm check:package$/);
  assert.match(script('check:tooling'), /pnpm check:package$/);
  // The minimum-Node job runs the script directly — the repo's pinned pnpm needs a newer Node than
  // the floor that job covers — so it must still name the same entry point the script does.
  assert.match(script('check:package'), /scripts\/check-package\.ts$/);
  assert.match(
    packagedCliWorkflow,
    /run: node --experimental-strip-types scripts\/check-package\.ts/,
  );
});

test('MCP registry publishing verifies an immutable publisher before OIDC login', () => {
  assert.match(mcpRegistryWorkflow, /MCP_PUBLISHER_VERSION: v1\.8\.1/);
  assert.match(mcpRegistryWorkflow, /MCP_PUBLISHER_ASSET: mcp-publisher_linux_amd64\.tar\.gz/);
  assert.match(
    mcpRegistryWorkflow,
    /MCP_PUBLISHER_SHA256: a06c9096dcb9727c13555b6be26c7effa707b01f06a4c561ba7a3635443cf2cc/,
  );
  assert.doesNotMatch(mcpRegistryWorkflow, /releases\/latest/);
  assert.doesNotMatch(mcpRegistryWorkflow, /curl[^\n]*\|[^\n]*tar/);

  const downloadIndex = mcpRegistryWorkflow.indexOf(
    '/releases/download/${MCP_PUBLISHER_VERSION}/${MCP_PUBLISHER_ASSET}',
  );
  const verificationIndex = mcpRegistryWorkflow.indexOf('sha256sum --check --strict');
  const extractionIndex = mcpRegistryWorkflow.indexOf('tar -xzf');
  const smokeCheckIndex = mcpRegistryWorkflow.indexOf('./mcp-publisher --version');
  const loginIndex = mcpRegistryWorkflow.indexOf('./mcp-publisher login github-oidc');
  const publishIndex = mcpRegistryWorkflow.indexOf('./mcp-publisher publish server.json');

  for (const [label, index] of [
    ['versioned download', downloadIndex],
    ['checksum verification', verificationIndex],
    ['archive extraction', extractionIndex],
    ['version smoke check', smokeCheckIndex],
    ['OIDC login', loginIndex],
    ['registry publish', publishIndex],
  ] as const) {
    assert.notEqual(index, -1, `workflow must contain ${label}`);
  }
  assert.ok(downloadIndex < verificationIndex, 'download must precede checksum verification');
  assert.ok(verificationIndex < extractionIndex, 'verification must precede extraction');
  assert.ok(extractionIndex < smokeCheckIndex, 'installation must precede the version smoke check');
  assert.ok(smokeCheckIndex < loginIndex, 'version smoke check must precede OIDC login');
  assert.ok(loginIndex < publishIndex, 'OIDC login must precede publish');
});
