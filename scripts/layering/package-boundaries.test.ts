// R11 package-boundaries fires on every bypass and holds on the one exception.
// Necessary for the same reason as zone-policy.test.ts: the real tree is clean,
// so a rule that stopped matching would look exactly like a rule being obeyed.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { FACADE_SYMBOLS } from './facade-symbols.ts';
import {
  checkPackageBoundaries,
  checkPackageInternalSites,
  checkRootSites,
  readFacadeExports,
  readNamedExports,
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

test('readNamedExports collects re-export and direct-declaration forms, resolving aliases', () => {
  const source = [
    "export { a, b } from './x.ts';",
    "export type { C, D } from './y.ts';",
    "export { e as f } from './z.ts';",
    "export type { g as h } from './z.ts';",
    'export function i() {}',
    'export const j = 1;',
    'export type K = string;',
    'export interface L {}',
    "export {\n  m,\n  n,\n} from './multi.ts';",
  ].join('\n');
  assert.deepEqual(
    readNamedExports(source),
    ['D', 'C', 'K', 'L', 'a', 'b', 'f', 'h', 'i', 'j', 'm', 'n'].sort(),
  );
});

test('readNamedExports never reports the original name behind an `as` alias', () => {
  const source = "export { internalOnly as publicName } from './x.ts';";
  const names = readNamedExports(source);
  assert.deepEqual(names, ['publicName']);
  assert.ok(!names.includes('internalOnly'));
});

test('readNamedExports resolves `export * as ns` to its one real bound name', () => {
  // Unlike bare `export *`, this binds exactly one importable name (`ns`) —
  // enumerable, not a widening blind spot.
  const source = "export * as ns from './x.ts';";
  assert.deepEqual(readNamedExports(source), ['ns']);
});

// #1555 review P1 (second pass, "the gate also ignores export-star
// declarations, so it can miss future widening"): a facade pinned to an
// exact named-export list must not silently accept a form that widens its
// real surface with no enumerable name at all. These two forms throw instead
// of contributing nothing to the list — plant-verified (temporarily reverted
// to a no-op, confirmed both tests failed, restored) rather than merely
// asserted.
test('readNamedExports rejects a bare `export *` re-export', () => {
  const source = "export { runAdReplay } from './step-loop.ts';\nexport * from './leak.ts';\n";
  assert.throws(() => readNamedExports(source), /export \* from/);
});

test('readNamedExports rejects a default export', () => {
  assert.throws(() => readNamedExports('export default function leak() {}'), /export default/);
  assert.throws(() => readNamedExports('export default 42;'), /export default/);
});

test('readNamedExports reports `export { default as x }` as the named symbol x', () => {
  // The one form that sits between the two rejection rules above: the LOCAL
  // name is `default`, but what it binds in this module — and the only thing
  // a consumer can import — is `x`. Enumerable, so it must be reported, not
  // thrown; and `default` must never appear in the list.
  const names = readNamedExports("export { default as x, b } from './y.ts';");
  assert.deepEqual(names, ['b', 'x']);
  assert.ok(!names.includes('default'));
});

test('readNamedExports collects a local `export { … }` list with no `from`', () => {
  // The re-export tests above all carry a `from`; a façade that declares
  // first and exports at the bottom is the same public surface.
  assert.deepEqual(
    readNamedExports('const a = 1;\ntype T = string;\nexport { a };\nexport type { T };'),
    ['T', 'a'],
  );
});

test('readNamedExports collects every declarator of a multi-declarator export', () => {
  // Documented in the helper's contract; the direct-declaration test above
  // only exercises a single declarator, so the second name went unpinned.
  assert.deepEqual(readNamedExports('export const a = 1, b = 2;'), ['a', 'b']);
});

// `readFacadeExports` is the same enumeration widened from one source string
// to the re-export CHAIN behind a file — the form every `contracts` façade
// is built from. These use the real tree's own barrels rather than fixtures:
// a fixture would pin the walker against a file this repo never ships.
test('readFacadeExports resolves a bare `export *` chain the source-only reader refuses', () => {
  const barrel = path.join(repoRoot, 'packages/contracts/src/facades/session.ts');
  // Source-only: unknowable, so it throws (the merged contract, unchanged).
  assert.throws(() => readNamedExports(fs.readFileSync(barrel, 'utf8')), /export \* from/);
  // Given the FILE, the same barrel is fully enumerable.
  assert.deepEqual(readFacadeExports(barrel), [
    'SESSION_SURFACES',
    'SessionAction',
    'SessionSurface',
    'parseSessionSurface',
  ]);
});

test('readFacadeExports refuses a bare `export *` across a package specifier', () => {
  // A relative star names a module this gate can read; a package star means
  // resolving node_modules into another package's exports map — unbounded
  // widening, the exact thing the gate refuses.
  const scratch = path.join(repoRoot, 'packages/contracts/src/facades/.export-star-probe.ts');
  fs.writeFileSync(scratch, "export * from '@agent-device/kernel/errors';\n");
  try {
    assert.throws(() => readFacadeExports(scratch), /only a relative re-export/);
  } finally {
    fs.rmSync(scratch);
  }
});

/** Write throwaway modules next to a real façade; always clean them up. */
function withProbeModules(files: Record<string, string>, run: (dir: string) => void): void {
  const dir = path.join(repoRoot, 'packages/contracts/src/facades');
  const written = Object.entries(files).map(([name, source]) => {
    const file = path.join(dir, name);
    fs.writeFileSync(file, source);
    return file;
  });
  try {
    run(dir);
  } finally {
    for (const file of written) fs.rmSync(file, { force: true });
  }
}

test('readFacadeExports excludes a default that a star export cannot reach', () => {
  // #1574 review P1: `export *` skips the child's default per
  // GetExportedNames, so a private default in a leaf is NOT part of the
  // barrel's surface. Counterfactual: the named sibling still comes through,
  // proving the leaf is genuinely being read and the default specifically —
  // not the whole module — is what got dropped.
  withProbeModules(
    {
      '.leaf-probe.ts': 'export default function hidden() {}\nexport const reachable = 1;\n',
      '.barrel-probe.ts': "export * from './.leaf-probe.ts';\n",
    },
    (dir) => {
      assert.deepEqual(readFacadeExports(path.join(dir, '.barrel-probe.ts')), ['reachable']);
    },
  );
});

test('readFacadeExports still rejects a default on the façade entry itself', () => {
  // The other side of the same rule: the entry's own default IS a default
  // export of the façade, and a façade pinned to a named list must not carry
  // one. Same source text as the leaf above — only its position changed.
  withProbeModules({ '.entry-default-probe.ts': 'export default function leak() {}\n' }, (dir) => {
    assert.throws(
      () => readFacadeExports(path.join(dir, '.entry-default-probe.ts')),
      /export default/,
    );
  });
});

test('readFacadeExports rejects a name two star sources resolve differently', () => {
  // ESM resolves this to `ambiguous`, so `clash` is not importable at all;
  // unioning would pin a symbol no consumer can reach.
  withProbeModules(
    {
      '.clash-a-probe.ts': 'export const clash = 1;\nexport const onlyA = 1;\n',
      '.clash-b-probe.ts': 'export const clash = 2;\n',
      '.clash-barrel-probe.ts':
        "export * from './.clash-a-probe.ts';\nexport * from './.clash-b-probe.ts';\n",
    },
    (dir) => {
      assert.throws(() => readFacadeExports(path.join(dir, '.clash-barrel-probe.ts')), /ambiguous/);
    },
  );
});

test('readFacadeExports resolves a diamond and lets an explicit export shadow a star', () => {
  // The two counterfactuals to the ambiguity rule, both of which a naive
  // "two paths reached this name" check would wrongly reject. One shared
  // declaration reached by two barrels is ONE binding, not a clash; and an
  // explicit re-export of a name a star also provides is the spec's own
  // precedence, not ambiguity.
  withProbeModules(
    {
      '.shared-probe.ts': 'export const shared = 1;\n',
      '.mid-one-probe.ts': "export * from './.shared-probe.ts';\n",
      '.mid-two-probe.ts': "export * from './.shared-probe.ts';\n",
      '.diamond-probe.ts':
        "export * from './.mid-one-probe.ts';\nexport * from './.mid-two-probe.ts';\n",
      '.shadow-src-probe.ts': 'export const shadowed = 1;\nexport const other = 2;\n',
      '.shadow-probe.ts':
        "export * from './.shadow-src-probe.ts';\nexport { shadowed } from './.shared-probe.ts';\n",
    },
    (dir) => {
      assert.deepEqual(readFacadeExports(path.join(dir, '.diamond-probe.ts')), ['shared']);
      assert.deepEqual(readFacadeExports(path.join(dir, '.shadow-probe.ts')), [
        'other',
        'shadowed',
      ]);
    },
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
