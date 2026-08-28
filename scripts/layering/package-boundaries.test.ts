// R11 package-boundaries fires on every bypass and holds on the one exception.
// Necessary for the same reason as zone-policy.test.ts: the real tree is clean,
// so a rule that stopped matching would look exactly like a rule being obeyed.

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { listSourceFiles } from './check.ts';
import { readDirectNamedExports, readNamedExports, readReExportSources } from './facade-exports.ts';
import {
  checkPackageBoundaries,
  facadeEntryFiles,
  checkPackageInternalSites,
  checkRootSites,
  readWorkspacePackages,
  rootExternalDependencyRanges,
  rootWorkspaceDependencyNames,
  specifierSites,
  type WorkspacePackage,
} from './package-boundaries.ts';

const repoRoot = path.resolve(import.meta.dirname, '../..');

const kernel: WorkspacePackage = {
  dir: 'packages/kernel',
  name: '@agent-device/kernel',
  exportTargets: new Map([
    ['@agent-device/kernel/errors', 'packages/kernel/src/errors.ts'],
    ['@agent-device/kernel/device', 'packages/kernel/src/device.ts'],
  ]),
  workspaceDependencies: new Set(),
  externalDependencies: new Map(),
};

const contracts: WorkspacePackage = {
  dir: 'packages/contracts',
  name: '@agent-device/contracts',
  exportTargets: new Map([
    ['@agent-device/contracts/interaction', 'packages/contracts/src/interaction.ts'],
  ]),
  workspaceDependencies: new Set(['@agent-device/kernel']),
  externalDependencies: new Map(),
};

const ALL = [kernel, contracts];
const CONTRACT_EXPORTS = [
  '@agent-device/contracts/alert-contract',
  '@agent-device/contracts/alert-runtime',
  '@agent-device/contracts/android-clipboard-support',
  '@agent-device/contracts/android-helper-artifacts',
  '@agent-device/contracts/android-input-ownership',
  '@agent-device/contracts/android-observation',
  '@agent-device/contracts/android-snapshot-quality',
  '@agent-device/contracts/android-system-chrome',
  '@agent-device/contracts/android-touch-plan',
  '@agent-device/contracts/app-deployment-runtime',
  '@agent-device/contracts/app-deployment-runtime-plan',
  '@agent-device/contracts/app-event-runtime',
  '@agent-device/contracts/app-inventory-runtime',
  '@agent-device/contracts/app-log-runtime',
  '@agent-device/contracts/app-state-runtime',
  '@agent-device/contracts/app-switcher-runtime',
  '@agent-device/contracts/apple-multitouch-support',
  '@agent-device/contracts/apple-runner-request',
  '@agent-device/contracts/application-lifecycle-interaction',
  '@agent-device/contracts/application-lifecycle-runtime',
  '@agent-device/contracts/application-lifecycle-runtime-plan',
  '@agent-device/contracts/async-lifecycle',
  '@agent-device/contracts/audio-probe-result',
  '@agent-device/contracts/audio-probe-runtime',
  '@agent-device/contracts/audio-probe-runtime-host',
  '@agent-device/contracts/audio-probe-support',
  '@agent-device/contracts/audio-runtime-plan',
  '@agent-device/contracts/back-mode',
  '@agent-device/contracts/backend-diagnostics',
  '@agent-device/contracts/back-runtime',
  '@agent-device/contracts/boot-failure',
  '@agent-device/contracts/capture',
  '@agent-device/contracts/click-button',
  '@agent-device/contracts/client',
  '@agent-device/contracts/clipboard',
  '@agent-device/contracts/clipboard-runtime',
  '@agent-device/contracts/command',
  '@agent-device/contracts/command-platform-execution',
  '@agent-device/contracts/device',
  '@agent-device/contracts/device-readiness-runtime',
  '@agent-device/contracts/device-shutdown-runtime',
  '@agent-device/contracts/divergence',
  '@agent-device/contracts/durable-resource',
  '@agent-device/contracts/durable-resource-envelope',
  '@agent-device/contracts/element-text-runtime',
  '@agent-device/contracts/focus-runtime',
  '@agent-device/contracts/gesture-admission',
  '@agent-device/contracts/gesture-input',
  '@agent-device/contracts/gesture-normalization',
  '@agent-device/contracts/gesture-plan',
  '@agent-device/contracts/gesture-plan-types',
  '@agent-device/contracts/gesture-runtime',
  '@agent-device/contracts/home-runtime',
  '@agent-device/contracts/host-diagnostics',
  '@agent-device/contracts/daemon-owner-cleanup',
  '@agent-device/contracts/interaction',
  '@agent-device/contracts/interaction-error',
  '@agent-device/contracts/interaction-guarantees',
  '@agent-device/contracts/interactor-operation-catalog',
  '@agent-device/contracts/interactor-types',
  '@agent-device/contracts/keyboard',
  '@agent-device/contracts/keyboard-runtime',
  '@agent-device/contracts/local-interactor-operation-set',
  '@agent-device/contracts/logs-runtime-plan',
  '@agent-device/contracts/managed-web-backend',
  '@agent-device/contracts/navigation',
  '@agent-device/contracts/network-runtime',
  '@agent-device/contracts/network-runtime-plan',
  '@agent-device/contracts/network-traffic',
  '@agent-device/contracts/observability',
  '@agent-device/contracts/orientation-runtime',
  '@agent-device/contracts/perf-runtime',
  '@agent-device/contracts/perf-runtime-host',
  '@agent-device/contracts/perf-runtime-operation-builder',
  '@agent-device/contracts/perf-runtime-plan',
  '@agent-device/contracts/platform-module',
  '@agent-device/contracts/platform-plugin',
  '@agent-device/contracts/platform-providers',
  '@agent-device/contracts/platform-resource-cleanup',
  '@agent-device/contracts/platform-runtime',
  '@agent-device/contracts/platform-runtime-host',
  '@agent-device/contracts/platform-runtime-operations',
  '@agent-device/contracts/platform-runtime-unavailable',
  '@agent-device/contracts/progress',
  '@agent-device/contracts/record-runtime-execution',
  '@agent-device/contracts/recording',
  '@agent-device/contracts/remote',
  '@agent-device/contracts/replay',
  '@agent-device/contracts/react-native-overlay',
  '@agent-device/contracts/runner-lease-context',
  '@agent-device/contracts/screen-recording-runtime',
  '@agent-device/contracts/screen-recording-runtime-host',
  '@agent-device/contracts/screen-recording-runtime-plan',
  '@agent-device/contracts/screenshot-runtime',
  '@agent-device/contracts/scroll-command',
  '@agent-device/contracts/scroll-gesture',
  '@agent-device/contracts/scroll-runtime',
  '@agent-device/contracts/selector-observation-runtime',
  '@agent-device/contracts/session',
  '@agent-device/contracts/settings',
  '@agent-device/contracts/settings-runtime',
  '@agent-device/contracts/snapshot',
  '@agent-device/contracts/snapshot-presentation',
  '@agent-device/contracts/snapshot-runtime',
  '@agent-device/contracts/snapshot-scope',
  '@agent-device/contracts/snapshot-timeout-evidence',
  '@agent-device/contracts/startup-recovery-fence',
  '@agent-device/contracts/touch-runtime',
  '@agent-device/contracts/tv-remote',
  '@agent-device/contracts/tv-remote-runtime',
  '@agent-device/contracts/type-text-runtime',
  '@agent-device/contracts/viewport-runtime',
  '@agent-device/contracts/wait',
  '@agent-device/contracts/wait-runtime-plan',
] as const;

function rules(violations: { rule: string }[]): string[] {
  return violations.map((violation) => violation.rule);
}

test('specifier sites carry 1-based lines for static and dynamic imports', () => {
  const sites = specifierSites(
    'src/a.ts',
    ["import { x } from './b.ts';", '', "void import('../c.ts');"].join('\n'),
  );
  assert.deepEqual(
    sites.map(({ specifier, line }) => `${line}:${specifier}`),
    ['1:./b.ts', '3:../c.ts'],
  );
});

test('readWorkspacePackages reads tracked manifests only', () => {
  // R11's own committed-state property, and the source-level half of the #1965 review finding.
  // `readWorkspacePackages` used to enumerate `packages/` with `readdirSync`, so an uncommitted
  // scratch package contributed a name, export targets, and dependency edges to every rule built
  // on it — R11 could fail on work a contributor had not committed. Filtering the OUTPUT of
  // façade discovery hides that from one caller; this closes it for all of them.
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'package-boundaries-tracked-manifests-'));
  const committed = path.join(repo, 'packages/committed');
  fs.mkdirSync(path.join(committed, 'src'), { recursive: true });
  fs.writeFileSync(
    path.join(committed, 'package.json'),
    JSON.stringify({ name: '@agent-device/committed', exports: { '.': './src/index.ts' } }),
  );
  fs.writeFileSync(path.join(committed, 'src/index.ts'), 'export const a = 1;\n');
  execFileSync('git', ['init', '-q'], { cwd: repo });
  execFileSync('git', ['add', '.'], { cwd: repo });
  execFileSync(
    'git',
    ['-c', 'user.name=Gate', '-c', 'user.email=gate@example.test', 'commit', '-qm', 'base'],
    { cwd: repo },
  );

  const scratch = path.join(repo, 'packages/scratch');
  fs.mkdirSync(path.join(scratch, 'src'), { recursive: true });
  fs.writeFileSync(
    path.join(scratch, 'package.json'),
    JSON.stringify({
      name: '@agent-device/scratch',
      exports: { '.': './src/index.ts' },
      dependencies: { '@agent-device/committed': 'workspace:*' },
    }),
  );
  fs.writeFileSync(path.join(scratch, 'src/index.ts'), 'export const b = 2;\n');

  const names = readWorkspacePackages(repo).map((pkg) => pkg.name);
  assert.deepEqual(names, ['@agent-device/committed']);
  assert.ok(
    !names.includes('@agent-device/scratch'),
    'an uncommitted package directory is not part of the committed state R11 describes',
  );
});

test('every workspace package façade names its exports explicitly (no bare `export *`)', () => {
  // #1574 built a hand-maintained pin table (`facade-symbols.ts`, 816 symbols across every
  // workspace-package façade) plus a ~200-line star-chain resolver (`readFacadeExports`) whose
  // entire job was enumerating what `export *` hides. Once a façade names its exports explicitly,
  // the façade file itself IS the pin — a widening shows up in the diff of the file that grew,
  // not in a table two files away that only a gate failure would surface. This structural gate is
  // what keeps that property true: every façade a package manifest declares (`exportTargets`),
  // plus every production file under a `src/facades/` directory, must parse through
  // `readNamedExports` without hitting the bare-`export *`/`export default` rejection it already
  // implements — reusing that check rather than writing a second, regex-based one that would have
  // to independently rediscover every export form to be trustworthy.
  //
  // The façade set comes from `facadeEntryFiles`, the single owner of "what is an entry surface".
  // The ADR-0019 eager-closure budget table consumes the same function, so a file this gate holds
  // to an explicit export list is necessarily a file that gate holds to a loading-shape budget.
  const facadeFiles = facadeEntryFiles(repoRoot);
  assert.ok(facadeFiles.length > 0, 'expected at least one workspace package façade to check');
  for (const file of facadeFiles) {
    const source = fs.readFileSync(path.join(repoRoot, file), 'utf8');
    try {
      readNamedExports(source);
    } catch (error) {
      assert.fail(
        `${file} must name its exports explicitly instead of a bare \`export *\` (or an ` +
          '`export default`) — a façade widened by a star re-export hides the new symbol from ' +
          'its own diff, exactly what the retired symbol-pin table (#1574) used to catch by ' +
          `hand. Underlying error: ${(error as Error).message}`,
      );
    }
  }
});

test('every façade re-exports its sources exhaustively (no silent narrowing)', () => {
  // The star-rejection above catches a façade WIDENING invisibly. This catches the
  // opposite, which is the failure an explicit list makes newly possible: a symbol
  // added to a source module simply never reaches the façade, and nothing notices.
  // `export *` could not narrow by construction; an explicit list can, so the
  // property `export *` gave for free is asserted here instead.
  //
  // Found by review on #1614: this conversion was generated against the surface at
  // fork time, and #1567 landed 13 new exports meanwhile (`DragOptions`, the drag
  // gesture vocabulary, `MultiTargetAnnotationV1`). The rebase silently dropped all
  // 13 and only a human diff caught it. Exhaustiveness is what makes that mechanical.
  //
  // Scoped to `packages/*/src/facades/` — the barrels this PR converted, which were
  // exhaustive by construction because `export *` cannot narrow. A hand-curated
  // package `index.ts` is a different thing: `@agent-device/ad-replay` deliberately
  // publishes two values out of a much larger `internal/`, and forcing it exhaustive
  // would widen a surface its owner narrowed on purpose (#1555).
  const facadeFiles = listSourceFiles().filter((file) => file.includes('/src/facades/'));
  assert.ok(facadeFiles.length > 0, 'expected at least one converted façade to check');
  for (const file of [...facadeFiles].sort()) {
    const absolute = path.join(repoRoot, file);
    const exported = new Set(readNamedExports(fs.readFileSync(absolute, 'utf8')));
    for (const specifier of reExportSources(fs.readFileSync(absolute, 'utf8'))) {
      const sourcePath = path.resolve(path.dirname(absolute), specifier);
      if (!fs.existsSync(sourcePath)) continue;
      // A source may itself carry a bare `export *` (contracts' `gesture-plan.ts`
      // stars `gesture-plan-types.ts`). Read its DIRECT exports rather than skipping
      // the file: skipping would also drop `buildDragGesturePlan` and friends from
      // this check, so removing one from a façade would narrow the surface silently
      // (#1614 review P2). The starred names are covered because the façade
      // re-exports the starred module directly too, and that path is checked here on
      // its own turn.
      const sourceNames = readDirectNamedExports(fs.readFileSync(sourcePath, 'utf8'));
      const dropped = sourceNames.filter((name) => name !== 'default' && !exported.has(name));
      assert.deepEqual(
        dropped,
        [],
        `${file} re-exports from ${specifier} but omits ${dropped.join(', ')} — an explicit ` +
          'façade list must stay exhaustive over its sources, or a symbol added upstream ' +
          'silently never becomes public. Add the names, or move them out of that module.',
      );
    }
  }
});

/** The relative specifiers a façade re-exports from, in source order. */
function reExportSources(source: string): string[] {
  const found = new Set<string>();
  for (const match of source.matchAll(/\bfrom\s+'(\.[^']*)'/g)) {
    const specifier = match[1];
    if (specifier) found.add(specifier);
  }
  return [...found];
}

test('double-quoted and re-export routes into packages are not invisible to R11', () => {
  // The scanner is the layering parser, so quote style and statement form
  // cannot carve out a bypass: a double-quoted import, a re-export, and a
  // double-quoted dynamic import into packages/*/src all reach the rule.
  const doubleQuoted = specifierSites(
    'src/utils/exec.ts',
    'import { AppError } from "../../packages/kernel/src/errors.ts";',
  );
  assert.equal(checkRootSites(doubleQuoted, ALL, new Set([kernel.name])).length, 1);

  const reExport = specifierSites(
    'src/utils/exec.ts',
    'export { AppError } from "../../packages/kernel/src/errors.ts";',
  );
  assert.equal(checkRootSites(reExport, ALL, new Set([kernel.name])).length, 1);

  const dynamic = specifierSites(
    'src/utils/exec.ts',
    'void import("../../packages/kernel/src/errors.ts");',
  );
  assert.equal(checkRootSites(dynamic, ALL, new Set([kernel.name])).length, 1);

  const packageEscape = specifierSites(
    'packages/kernel/src/errors.ts',
    'export * from "../../../src/utils/exec.ts";',
  );
  assert.equal(checkPackageInternalSites(kernel, packageEscape, ALL).length, 1);
});

test('a package file importing root src is a violation', () => {
  const sites = specifierSites(
    'packages/kernel/src/errors.ts',
    "import { helper } from '../../../src/utils/exec.ts';",
  );
  assert.deepEqual(rules(checkPackageInternalSites(kernel, sites, ALL)), [
    'R11 package-boundaries',
  ]);
});

test('intra-package relative imports hold', () => {
  const sites = specifierSites(
    'packages/kernel/src/daemon-error.ts',
    "import { AppError } from './errors.ts';",
  );
  assert.deepEqual(checkPackageInternalSites(kernel, sites, ALL), []);
});

test('an exported package self-reference holds while a deep self-import fails', () => {
  const exported = specifierSites(
    'packages/kernel/src/errors.test.ts',
    "import { AppError } from '@agent-device/kernel/errors';",
  );
  assert.deepEqual(checkPackageInternalSites(kernel, exported, ALL), []);

  const deep = specifierSites(
    'packages/kernel/src/errors.test.ts',
    "import { AppError } from '@agent-device/kernel/src/errors.ts';",
  );
  assert.equal(checkPackageInternalSites(kernel, deep, ALL).length, 1);
});

test('a cross-package import needs a workspace:* declaration and an exported subpath', () => {
  const declared = specifierSites(
    'packages/contracts/src/gesture.ts',
    "import { AppError } from '@agent-device/kernel/errors';",
  );
  assert.deepEqual(checkPackageInternalSites(contracts, declared, ALL), []);

  const undeclared = specifierSites(
    'packages/kernel/src/errors.ts',
    "import { g } from '@agent-device/contracts/interaction';",
  );
  assert.equal(checkPackageInternalSites(kernel, undeclared, ALL).length, 1);

  const deep = specifierSites(
    'packages/contracts/src/gesture.ts',
    "import { internal } from '@agent-device/kernel/internal/secret';",
  );
  assert.equal(checkPackageInternalSites(contracts, deep, ALL).length, 1);
});

test('a root src file tunnelling into packages/*/src relatively is a violation', () => {
  const sites = specifierSites(
    'src/utils/exec.ts',
    "import { AppError } from '../../packages/kernel/src/errors.ts';",
  );
  const violations = checkRootSites(sites, ALL, new Set([kernel.name]));
  assert.deepEqual(rules(violations), ['R11 package-boundaries']);
  assert.match(violations[0]!.message, /instantiate the module twice/);
});

// The R8 zero-dep exception retired with R8 (#1781 A6). `scripts/` placement never
// proved anything about dual instantiation on its own, and there is no longer a job
// whose absent node_modules could prove it, so the route is closed to every caller —
// exports-named target or not.
test('a scripts/ file gets no relative route into a package either', () => {
  const exportsNamed = specifierSites(
    'scripts/some-tool/run.ts',
    "import { AppError } from '../../packages/kernel/src/errors.ts';",
  );
  assert.equal(checkRootSites(exportsNamed, ALL, new Set([kernel.name])).length, 1);

  const nonExported = specifierSites(
    'scripts/some-tool/run.ts',
    "import { hidden } from '../../packages/kernel/src/internal.ts';",
  );
  assert.equal(checkRootSites(nonExported, ALL, new Set([kernel.name])).length, 1);
});

test('root workspace specifiers need a root workspace:* entry and an exported subpath', () => {
  const fine = specifierSites(
    'src/cli.ts',
    "import { AppError } from '@agent-device/kernel/errors';",
  );
  assert.deepEqual(checkRootSites(fine, ALL, new Set([kernel.name])), []);

  const undeclared = checkRootSites(fine, ALL, new Set());
  assert.equal(undeclared.length, 1);
  assert.match(undeclared[0]!.message, /workspace:\*/);

  const deep = specifierSites(
    'src/cli.ts',
    "import { x } from '@agent-device/kernel/src/errors.ts';",
  );
  assert.equal(checkRootSites(deep, ALL, new Set([kernel.name])).length, 1);

  const unknown = specifierSites('src/cli.ts', "import { x } from '@agent-device/nope/thing';");
  assert.equal(checkRootSites(unknown, ALL, new Set([kernel.name])).length, 1);
});

test('the real tree parses, declares, and passes R11', () => {
  const packages = readWorkspacePackages(repoRoot);
  assert.ok(packages.length >= 1, 'expected at least the kernel package');
  const kernelPackage = packages.find((pkg) => pkg.name === '@agent-device/kernel');
  assert.ok(kernelPackage, 'kernel package must exist');
  assert.ok(kernelPackage.exportTargets.size >= 8, 'kernel exports its vocabulary subpaths');
  const contractsPackage = packages.find((pkg) => pkg.name === '@agent-device/contracts');
  assert.ok(contractsPackage, 'contracts package must exist');
  assert.deepEqual([...contractsPackage.exportTargets.keys()].sort(), [...CONTRACT_EXPORTS].sort());
  assert.deepEqual([...contractsPackage.workspaceDependencies], ['@agent-device/kernel']);
  const captureKitPackage = packages.find((pkg) => pkg.name === '@agent-device/capture-kit');
  assert.ok(captureKitPackage, 'capture-kit package must exist');
  assert.equal(
    JSON.parse(fs.readFileSync(path.join(repoRoot, 'packages/capture-kit/package.json'), 'utf8'))
      .private,
    true,
    'capture-kit stays a private implementation package',
  );
  assert.deepEqual([...captureKitPackage.exportTargets.keys()].sort(), [
    '@agent-device/capture-kit',
    '@agent-device/capture-kit/mobile-snapshot-semantics',
    '@agent-device/capture-kit/png',
    '@agent-device/capture-kit/png-resize',
    '@agent-device/capture-kit/png-rgb-difference',
    '@agent-device/capture-kit/png-size',
    '@agent-device/capture-kit/png-worker-client',
    '@agent-device/capture-kit/screenshot-density',
    '@agent-device/capture-kit/screenshot-diff-pixels',
    '@agent-device/capture-kit/snapshot-desktop-projection',
    '@agent-device/capture-kit/snapshot-occlusion',
    '@agent-device/capture-kit/snapshot-quality-backend-capabilities',
    '@agent-device/capture-kit/snapshot-quality-verdict',
  ]);

  const provisionKitPackage = packages.find((pkg) => pkg.name === '@agent-device/provision-kit');
  assert.ok(provisionKitPackage, 'provision-kit package must exist');
  assert.equal(
    JSON.parse(fs.readFileSync(path.join(repoRoot, 'packages/provision-kit/package.json'), 'utf8'))
      .private,
    true,
    'provision-kit stays a private implementation package',
  );
  assert.deepEqual([...provisionKitPackage.exportTargets.keys()].sort(), [
    '@agent-device/provision-kit/app-resolution-cache',
    '@agent-device/provision-kit/boot-diagnostics',
    '@agent-device/provision-kit/install-artifact-archive-context',
    '@agent-device/provision-kit/install-source',
    '@agent-device/provision-kit/install-source-network',
    '@agent-device/provision-kit/install-source-network-transport',
    '@agent-device/provision-kit/toolchain-probe',
  ]);
  assert.deepEqual([...provisionKitPackage.workspaceDependencies].sort(), [
    '@agent-device/contracts',
    '@agent-device/host-kit',
    '@agent-device/kernel',
  ]);
  assert.deepEqual([...captureKitPackage.workspaceDependencies].sort(), [
    '@agent-device/contracts',
    '@agent-device/host-kit',
    '@agent-device/kernel',
  ]);
  const hostKitPackage = packages.find((pkg) => pkg.name === '@agent-device/host-kit');
  assert.ok(hostKitPackage, 'host-kit package must exist');
  assert.equal(
    JSON.parse(fs.readFileSync(path.join(repoRoot, 'packages/host-kit/package.json'), 'utf8'))
      .private,
    true,
    'host-kit stays a private implementation package',
  );
  assert.deepEqual([...hostKitPackage.exportTargets.keys()].sort(), [
    '@agent-device/host-kit/archive',
    '@agent-device/host-kit/command',
    '@agent-device/host-kit/diagnostics',
    '@agent-device/host-kit/file',
    '@agent-device/host-kit/host-file',
    '@agent-device/host-kit/process',
    '@agent-device/host-kit/request',
    '@agent-device/host-kit/retry',
    '@agent-device/host-kit/version',
  ]);
  assert.deepEqual([...hostKitPackage.workspaceDependencies].sort(), [
    '@agent-device/contracts',
    '@agent-device/kernel',
  ]);
  const platformApplePackage = packages.find((pkg) => pkg.name === '@agent-device/platform-apple');
  assert.ok(platformApplePackage, 'platform-apple package must exist');
  assert.deepEqual([...platformApplePackage.exportTargets.keys()].sort(), [
    '@agent-device/platform-apple',
    '@agent-device/platform-apple/app-lifecycle',
    '@agent-device/platform-apple/app-resolution',
    '@agent-device/platform-apple/debug-symbols',
    '@agent-device/platform-apple/doctor',
    '@agent-device/platform-apple/install-artifact',
    '@agent-device/platform-apple/macos',
    '@agent-device/platform-apple/perf',
    '@agent-device/platform-apple/physical-device',
    '@agent-device/platform-apple/runner',
    '@agent-device/platform-apple/runner-owner',
    '@agent-device/platform-apple/runner/operations',
    '@agent-device/platform-apple/runner/test-host',
    '@agent-device/platform-apple/simctl',
    '@agent-device/platform-apple/simulator',
    '@agent-device/platform-apple/tool-provider',
  ]);
  assert.deepEqual([...platformApplePackage.workspaceDependencies].sort(), [
    '@agent-device/capture-kit',
    '@agent-device/contracts',
    '@agent-device/host-kit',
    '@agent-device/kernel',
    '@agent-device/provision-kit',
    '@agent-device/xml',
  ]);
  const platformAndroidPackage = packages.find(
    (pkg) => pkg.name === '@agent-device/platform-android',
  );
  assert.ok(platformAndroidPackage, 'platform-android package must exist');
  assert.deepEqual([...platformAndroidPackage.exportTargets.keys()].sort(), [
    '@agent-device/platform-android',
    '@agent-device/platform-android/adb-host',
    '@agent-device/platform-android/mechanics',
  ]);
  assert.deepEqual([...platformAndroidPackage.workspaceDependencies].sort(), [
    '@agent-device/capture-kit',
    '@agent-device/contracts',
    '@agent-device/host-kit',
    '@agent-device/kernel',
    '@agent-device/provision-kit',
    '@agent-device/xml',
  ]);
  const maestroPackage = packages.find((pkg) => pkg.name === '@agent-device/maestro');
  assert.ok(maestroPackage, 'maestro package must exist');
  assert.deepEqual([...maestroPackage.exportTargets.keys()], ['@agent-device/maestro']);
  assert.deepEqual([...maestroPackage.workspaceDependencies].sort(), [
    '@agent-device/contracts',
    '@agent-device/kernel',
    '@agent-device/selectors',
  ]);
  const adScriptPackage = packages.find((pkg) => pkg.name === '@agent-device/ad-script');
  assert.ok(adScriptPackage, 'ad-script package must exist');
  // Locks the "exports only `.`" boundary: a future `/codec` (or any other)
  // subpath widens this key list and fails the assertion (#1478 P5 dossier).
  assert.deepEqual([...adScriptPackage.exportTargets.keys()], ['@agent-device/ad-script']);
  assert.deepEqual([...adScriptPackage.workspaceDependencies].sort(), [
    '@agent-device/contracts',
    '@agent-device/kernel',
  ]);
  const adReplayPackage = packages.find((pkg) => pkg.name === '@agent-device/ad-replay');
  assert.ok(adReplayPackage, 'ad-replay package must exist');
  // Locks the "exports only `.`" boundary: the stage-A wide façade and the
  // `./testing` subpath (the deleted in-memory selector adapter) are both gone
  // as of the direct selectors-package cutover — a future
  // `./testing` (or any other) subpath widens this key list and fails the
  // assertion.
  assert.deepEqual([...adReplayPackage.exportTargets.keys()], ['@agent-device/ad-replay']);
  assert.deepEqual([...adReplayPackage.workspaceDependencies].sort(), [
    '@agent-device/ad-script',
    '@agent-device/contracts',
    '@agent-device/kernel',
    '@agent-device/selectors',
  ]);
  // #1555 review P1 ("add the reviewer-required exact exported-symbol
  // gate"; second pass, "enforce the accepted two-entrypoint facade"; the
  // structural-quality review, "typed façade replaces the zero-type rule"):
  // the exports-subpath assertion above only proves the package exposes one
  // `.` entry point — it says nothing about what that entry point actually
  // NAMES. This pins the exact symbol list `packages/ad-replay/src/index.ts`
  // exports: the binding design's two VALUE entrypoints, `inspectAdReplay`
  // and `runAdReplay` (never a third value), plus the neutral vocabulary
  // their signatures are built from, named explicitly instead of every root
  // consumer hand-deriving `Parameters<...>`/`ReturnType<...>` off them (the
  // shim `src/daemon/ad-replay-facade-types.ts` used to centralize — since
  // deleted). `formatReplaySuccessMessage` (presentation, not engine policy)
  // stays out on purpose — it sits daemon-side beside its one caller. A
  // stray export — intentional or not, including a form `readNamedExports`
  // cannot enumerate a name for (`export *`, `export default` — see the
  // rejection tests below) — must edit this list too, not just slip through
  // the exports-subpath check.
  assert.deepEqual(
    readNamedExports(
      fs.readFileSync(path.join(repoRoot, 'packages/ad-replay/src/index.ts'), 'utf8'),
    ),
    [
      'AdReplayDispatchGuard',
      'AdReplayDispatchOutcome',
      'AdReplayGuardMismatchEvidence',
      'AdReplayLandmarkMismatchEvidence',
      'AdReplayManifest',
      'AdReplayScrubValue',
      'AdReplayStepFailure',
      'AdReplayStepRuntime',
      'AdReplayTargetBindingEvidence',
      'AdReplayTargetClassification',
      'AdReplayVarSources',
      'AdReplayVerificationEntry',
      'inspectAdReplay',
      'runAdReplay',
    ],
  );
  const selectorsPackage = packages.find((pkg) => pkg.name === '@agent-device/selectors');
  assert.ok(selectorsPackage, 'selectors package must exist');
  // Three subpaths, and each split is the point: `.` is the string-only façade
  // every in-repo consumer uses, `./ast` is the published parser surface that
  // `agent-device/selectors` has shipped since before the engine moved into
  // this package, and `./engine` is the resolve/list surface reserved for the
  // selector-pipeline owner (R19, #1656) — a route reaching it skips the
  // structural stages its policy row declares. A fourth subpath, or the AST
  // leaking into `.`, fails here.
  assert.deepEqual([...selectorsPackage.exportTargets.keys()].sort(), [
    '@agent-device/selectors',
    '@agent-device/selectors/ast',
    '@agent-device/selectors/engine',
  ]);
  assert.deepEqual([...selectorsPackage.workspaceDependencies].sort(), [
    '@agent-device/ad-script',
    '@agent-device/contracts',
    '@agent-device/kernel',
  ]);
  assert.deepEqual(
    readNamedExports(
      fs.readFileSync(path.join(repoRoot, 'packages/selectors/src/index.ts'), 'utf8'),
    ).filter((name) =>
      ['Selector', 'SelectorChain', 'SelectorTerm', 'SelectorKey', 'parseSelectorChain'].includes(
        name,
      ),
    ),
    [],
    'selectors façade keeps AST and grammar internals private',
  );
  // Named exports are not the whole boundary. A parser-side type reached
  // through a NESTED field — `PolicyResolutionOutcome.resolution` typed as
  // `AstSelectorResolution` — leaks the same objects while exporting none of
  // their names, and the assertion above stays green on it (#1649). What
  // separates the two is which module the type is re-exported FROM:
  // `public-resolution-types.ts` holds the string-flattened shapes,
  // `resolve-with-policy.ts` and `resolve.ts` hold the parser-side ones. A
  // resolution type re-exported from either of the latter means a flattening
  // step at the façade was skipped.
  const selectorsReExports = readReExportSources(
    fs.readFileSync(path.join(repoRoot, 'packages/selectors/src/index.ts'), 'utf8'),
  );
  assert.deepEqual(
    ['PolicyResolutionOutcome', 'SelectorResolution', 'SelectorChainMatchList'].filter(
      (name) => selectorsReExports.get(name) !== './internal/public-resolution-types.ts',
    ),
    [],
    'selectors façade must publish resolution shapes from public-resolution-types.ts, not from the parser-side modules',
  );
  // The AST subpath's one in-repo consumer is the published SDK re-export.
  // Anything else importing it means the string-only façade was bypassed.
  assert.deepEqual(
    listSourceFiles()
      .filter((file) => !file.startsWith('packages/selectors/'))
      .filter((file) => fs.existsSync(path.join(repoRoot, file)))
      .filter((file) =>
        fs.readFileSync(path.join(repoRoot, file), 'utf8').includes('@agent-device/selectors/ast'),
      ),
    ['src/sdk/selectors.ts'],
    'only the published SDK subpath may import the selector AST',
  );
  const providerWebDriverPackage = packages.find(
    (pkg) => pkg.name === '@agent-device/provider-webdriver',
  );
  assert.ok(providerWebDriverPackage, 'provider-webdriver package must exist');
  assert.deepEqual(
    [...providerWebDriverPackage.exportTargets.keys()],
    ['@agent-device/provider-webdriver'],
  );
  assert.deepEqual([...providerWebDriverPackage.workspaceDependencies].sort(), [
    '@agent-device/capture-kit',
    '@agent-device/contracts',
    '@agent-device/kernel',
    '@agent-device/xml',
  ]);
  const providerLimrunPackage = packages.find(
    (pkg) => pkg.name === '@agent-device/provider-limrun',
  );
  assert.ok(providerLimrunPackage, 'provider-limrun package must exist');
  assert.deepEqual(
    [...providerLimrunPackage.exportTargets.keys()],
    ['@agent-device/provider-limrun'],
  );
  assert.deepEqual([...providerLimrunPackage.workspaceDependencies].sort(), [
    '@agent-device/capture-kit',
    '@agent-device/contracts',
    '@agent-device/kernel',
  ]);
  const rootExternalDependencies = rootExternalDependencyRanges(repoRoot);
  for (const pkg of packages) {
    for (const [name, range] of pkg.externalDependencies) {
      assert.equal(
        rootExternalDependencies.get(name),
        range,
        `${pkg.name} external dependency ${name} must match the root dependency range`,
      );
    }
  }
  const xmlPackage = packages.find((pkg) => pkg.name === '@agent-device/xml');
  assert.ok(xmlPackage, 'xml package must exist');
  assert.deepEqual([...xmlPackage.exportTargets.keys()], ['@agent-device/xml']);
  assert.deepEqual([...xmlPackage.workspaceDependencies], []);
  assert.ok(
    rootWorkspaceDependencyNames(repoRoot).has('@agent-device/capture-kit'),
    'root must declare the capture-kit workspace dependency',
  );
  assert.ok(
    rootWorkspaceDependencyNames(repoRoot).has('@agent-device/kernel'),
    'root must declare the kernel workspace dependency',
  );
  assert.ok(
    rootWorkspaceDependencyNames(repoRoot).has('@agent-device/contracts'),
    'root must declare the contracts workspace dependency',
  );
  assert.ok(
    rootWorkspaceDependencyNames(repoRoot).has('@agent-device/maestro'),
    'root must declare the maestro workspace dependency',
  );
  assert.ok(
    rootWorkspaceDependencyNames(repoRoot).has('@agent-device/ad-script'),
    'root must declare the ad-script workspace dependency',
  );
  assert.ok(
    rootWorkspaceDependencyNames(repoRoot).has('@agent-device/ad-replay'),
    'root must declare the ad-replay workspace dependency',
  );
  assert.ok(
    rootWorkspaceDependencyNames(repoRoot).has('@agent-device/selectors'),
    'root must declare the selectors workspace dependency',
  );
  assert.ok(
    rootWorkspaceDependencyNames(repoRoot).has('@agent-device/provider-webdriver'),
    'root must declare the provider-webdriver workspace dependency',
  );
  assert.ok(
    rootWorkspaceDependencyNames(repoRoot).has('@agent-device/provider-limrun'),
    'root must declare the provider-limrun workspace dependency',
  );
  assert.ok(
    rootWorkspaceDependencyNames(repoRoot).has('@agent-device/xml'),
    'root must declare the xml workspace dependency',
  );
  assert.deepEqual(checkPackageBoundaries(repoRoot, new Set()), []);
});

test('Node resolution enforces the exports map at runtime', () => {
  // Real resolver, not the gate's model: a deep import is a resolution error,
  // and the legal subpath realpaths OUTSIDE node_modules (pnpm symlink), which
  // is what lets --experimental-strip-types load package sources in dev.
  const resolved = import.meta.resolve('@agent-device/kernel/errors');
  assert.ok(resolved.endsWith('packages/kernel/src/errors.ts'), resolved);
  for (const deep of [
    '@agent-device/kernel/src/errors.ts',
    '@agent-device/kernel/internal-not-exported',
    '@agent-device/kernel',
    '@agent-device/contracts/not-an-export',
    '@agent-device/contracts/src/gesture-plan.ts',
    '@agent-device/contracts',
    '@agent-device/contracts/src/snapshot-text.ts',
    '@agent-device/contracts/src/facades/snapshot.ts',
    '@agent-device/provider-webdriver/runtime',
    '@agent-device/provider-webdriver/src/runtime.ts',
    '@agent-device/provider-limrun/runtime',
    '@agent-device/provider-limrun/src/runtime.ts',
    '@agent-device/xml/internal/parser',
    '@agent-device/xml/src/index.ts',
    '@agent-device/ad-script/codec',
    '@agent-device/ad-script/internal/script.ts',
    '@agent-device/ad-script/src/index.ts',
    '@agent-device/ad-replay/testing',
    '@agent-device/ad-replay/internal/target-verification.ts',
    '@agent-device/ad-replay/src/index.ts',
    '@agent-device/selectors/internal/parse.ts',
    '@agent-device/selectors/src/index.ts',
  ]) {
    assert.throws(
      () => import.meta.resolve(deep),
      /ERR_PACKAGE_PATH_NOT_EXPORTED|Package subpath|No "exports" main/,
      `${deep} must not resolve`,
    );
  }

  const contractsResolved = import.meta.resolve('@agent-device/contracts/interaction');
  assert.ok(contractsResolved.endsWith('packages/contracts/src/interaction.ts'), contractsResolved);
  const contractsSnapshotResolved = import.meta.resolve('@agent-device/contracts/snapshot');
  assert.ok(
    contractsSnapshotResolved.endsWith('packages/contracts/src/facades/snapshot.ts'),
    contractsSnapshotResolved,
  );
  const contractsSnapshotPresentationResolved = import.meta
    .resolve('@agent-device/contracts/snapshot-presentation');
  assert.ok(
    contractsSnapshotPresentationResolved.endsWith(
      'packages/contracts/src/snapshot-presentation.ts',
    ),
    contractsSnapshotPresentationResolved,
  );
  const contractsReactNativeOverlayResolved = import.meta
    .resolve('@agent-device/contracts/react-native-overlay');
  assert.ok(
    contractsReactNativeOverlayResolved.endsWith('packages/contracts/src/react-native-overlay.ts'),
    contractsReactNativeOverlayResolved,
  );
  const contractsSnapshotTimeoutEvidenceResolved = import.meta
    .resolve('@agent-device/contracts/snapshot-timeout-evidence');
  assert.ok(
    contractsSnapshotTimeoutEvidenceResolved.endsWith(
      'packages/contracts/src/snapshot-timeout-evidence.ts',
    ),
    contractsSnapshotTimeoutEvidenceResolved,
  );
  const providerWebDriverResolved = import.meta.resolve('@agent-device/provider-webdriver');
  assert.ok(
    providerWebDriverResolved.endsWith('packages/provider-webdriver/src/index.ts'),
    providerWebDriverResolved,
  );
  const providerLimrunResolved = import.meta.resolve('@agent-device/provider-limrun');
  assert.ok(
    providerLimrunResolved.endsWith('packages/provider-limrun/src/index.ts'),
    providerLimrunResolved,
  );
  const xmlResolved = import.meta.resolve('@agent-device/xml');
  assert.ok(xmlResolved.endsWith('packages/xml/src/index.ts'), xmlResolved);
  const adScriptResolved = import.meta.resolve('@agent-device/ad-script');
  assert.ok(adScriptResolved.endsWith('packages/ad-script/src/index.ts'), adScriptResolved);
  const adReplayResolved = import.meta.resolve('@agent-device/ad-replay');
  assert.ok(adReplayResolved.endsWith('packages/ad-replay/src/index.ts'), adReplayResolved);
  const selectorsResolved = import.meta.resolve('@agent-device/selectors');
  assert.ok(selectorsResolved.endsWith('packages/selectors/src/index.ts'), selectorsResolved);
});
