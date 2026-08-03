// R11 package-boundaries fires on every bypass and holds on the one exception.
// Necessary for the same reason as zone-policy.test.ts: the real tree is clean,
// so a rule that stopped matching would look exactly like a rule being obeyed.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { readFacadeExports, readNamedExports } from './facade-exports.ts';
import { FACADE_SYMBOLS } from './facade-symbols.ts';
import {
  checkPackageBoundaries,
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
    ['@agent-device/contracts/interaction', 'packages/contracts/src/facades/interaction.ts'],
  ]),
  workspaceDependencies: new Set(['@agent-device/kernel']),
  externalDependencies: new Map(),
};

const ALL = [kernel, contracts];
const CONTRACT_EXPORTS = [
  '@agent-device/contracts/capture',
  '@agent-device/contracts/client',
  '@agent-device/contracts/command',
  '@agent-device/contracts/device',
  '@agent-device/contracts/divergence',
  '@agent-device/contracts/interaction',
  '@agent-device/contracts/observability',
  '@agent-device/contracts/platform',
  '@agent-device/contracts/progress',
  '@agent-device/contracts/recording',
  '@agent-device/contracts/remote',
  '@agent-device/contracts/replay',
  '@agent-device/contracts/session',
  '@agent-device/contracts/settings',
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

test('every workspace package façade exports exactly its pinned symbol list', () => {
  const packages = readWorkspacePackages(repoRoot);
  const pinned = new Map(FACADE_SYMBOLS.map(([specifier, names]) => [specifier, names]));
  // The table and the manifests must agree in BOTH directions: a new package
  // (or a new subpath on an existing one) that nobody pinned is exactly the
  // widening this gate exists to catch, so an unpinned façade fails here
  // rather than being silently skipped.
  const declared = packages
    .filter((pkg) => pkg.name !== '@agent-device/ad-replay')
    .flatMap((pkg) => [...pkg.exportTargets.keys()]);
  assert.deepEqual(
    declared.slice().sort(),
    [...pinned.keys()].sort(),
    'every exports-map subpath needs a pinned symbol list (and vice versa)',
  );
  for (const pkg of packages) {
    for (const [specifier, target] of pkg.exportTargets) {
      const expected = pinned.get(specifier);
      if (!expected) continue;
      assert.deepEqual(
        readFacadeExports(path.join(repoRoot, target)),
        [...expected],
        `${specifier} exports exactly its pinned symbol list`,
      );
    }
  }
});

test('double-quoted and re-export routes into packages are not invisible to R11', () => {
  // The scanner is the layering parser, so quote style and statement form
  // cannot carve out a bypass: a double-quoted import, a re-export, and a
  // double-quoted dynamic import into packages/*/src all reach the rule.
  const doubleQuoted = specifierSites(
    'src/utils/exec.ts',
    'import { AppError } from "../../packages/kernel/src/errors.ts";',
  );
  assert.equal(checkRootSites(doubleQuoted, ALL, new Set([kernel.name]), new Set()).length, 1);

  const reExport = specifierSites(
    'src/utils/exec.ts',
    'export { AppError } from "../../packages/kernel/src/errors.ts";',
  );
  assert.equal(checkRootSites(reExport, ALL, new Set([kernel.name]), new Set()).length, 1);

  const dynamic = specifierSites(
    'src/utils/exec.ts',
    'void import("../../packages/kernel/src/errors.ts");',
  );
  assert.equal(checkRootSites(dynamic, ALL, new Set([kernel.name]), new Set()).length, 1);

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
  const violations = checkRootSites(sites, ALL, new Set([kernel.name]), new Set());
  assert.deepEqual(rules(violations), ['R11 package-boundaries']);
  assert.match(violations[0]!.message, /instantiate the module twice/);
});

test('the R8 exception requires zero-dep closure membership AND an exports-named target', () => {
  const closure = new Set(['scripts/some-tool/run.ts']);
  const allowed = specifierSites(
    'scripts/some-tool/run.ts',
    "import { AppError } from '../../packages/kernel/src/errors.ts';",
  );
  assert.deepEqual(checkRootSites(allowed, ALL, new Set([kernel.name]), closure), []);

  // Same import, but the file is NOT in any zero-dep closure: scripts/
  // placement alone proves nothing about dual instantiation.
  assert.equal(checkRootSites(allowed, ALL, new Set([kernel.name]), new Set()).length, 1);

  const nonExported = specifierSites(
    'scripts/some-tool/run.ts',
    "import { hidden } from '../../packages/kernel/src/internal.ts';",
  );
  assert.equal(checkRootSites(nonExported, ALL, new Set([kernel.name]), closure).length, 1);
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
  assert.equal(checkRootSites(deep, ALL, new Set([kernel.name]), new Set()).length, 1);

  const unknown = specifierSites('src/cli.ts', "import { x } from '@agent-device/nope/thing';");
  assert.equal(checkRootSites(unknown, ALL, new Set([kernel.name]), new Set()).length, 1);
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
  const maestroPackage = packages.find((pkg) => pkg.name === '@agent-device/maestro');
  assert.ok(maestroPackage, 'maestro package must exist');
  assert.deepEqual([...maestroPackage.exportTargets.keys()], ['@agent-device/maestro']);
  assert.deepEqual([...maestroPackage.workspaceDependencies].sort(), [
    '@agent-device/contracts',
    '@agent-device/kernel',
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
  // `./testing` subpath (the in-memory selector-port adapter, relocated to
  // `src/__tests__/test-utils/`) are both gone as of P5 stage D — a future
  // `./testing` (or any other) subpath widens this key list and fails the
  // assertion.
  assert.deepEqual([...adReplayPackage.exportTargets.keys()], ['@agent-device/ad-replay']);
  assert.deepEqual([...adReplayPackage.workspaceDependencies].sort(), [
    '@agent-device/ad-script',
    '@agent-device/contracts',
    '@agent-device/kernel',
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
      'AdReplayVerifiedTargetGuard',
      'ReplayRecordedTargetDisambiguation',
      'ReplayRecordedTargetPolicy',
      'ReplayRecordedTargetResolution',
      'ReplaySelectorCandidateOptions',
      'ReplaySelectorExpressionOutcome',
      'ReplaySelectorGrammar',
      'ReplaySelectorPort',
      'inspectAdReplay',
      'runAdReplay',
    ],
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
    '@agent-device/contracts/gesture-plan',
    '@agent-device/contracts/src/gesture-plan.ts',
    '@agent-device/contracts',
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
  ]) {
    assert.throws(
      () => import.meta.resolve(deep),
      /ERR_PACKAGE_PATH_NOT_EXPORTED|Package subpath|No "exports" main/,
      `${deep} must not resolve`,
    );
  }

  const contractsResolved = import.meta.resolve('@agent-device/contracts/interaction');
  assert.ok(
    contractsResolved.endsWith('packages/contracts/src/facades/interaction.ts'),
    contractsResolved,
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
});
