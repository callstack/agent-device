// R11 package-boundaries fires on every bypass and holds on the one exception.
// Necessary for the same reason as zone-policy.test.ts: the real tree is clean,
// so a rule that stopped matching would look exactly like a rule being obeyed.

import assert from 'node:assert/strict';
import path from 'node:path';
import { test } from 'node:test';
import {
  checkPackageBoundaries,
  checkPackageInternalSites,
  checkRootSites,
  readWorkspacePackages,
  rootWorkspaceDependencyNames,
  specifierSites,
  type WorkspacePackage,
} from './package-boundaries.ts';

const kernel: WorkspacePackage = {
  dir: 'packages/kernel',
  name: '@agent-device/kernel',
  exportTargets: new Map([
    ['@agent-device/kernel/errors', 'packages/kernel/src/errors.ts'],
    ['@agent-device/kernel/device', 'packages/kernel/src/device.ts'],
  ]),
  workspaceDependencies: new Set(),
};

const contracts: WorkspacePackage = {
  dir: 'packages/contracts',
  name: '@agent-device/contracts',
  exportTargets: new Map([
    ['@agent-device/contracts/gesture', 'packages/contracts/src/gesture.ts'],
  ]),
  workspaceDependencies: new Set(['@agent-device/kernel']),
};

const ALL = [kernel, contracts];

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

test('a cross-package import needs a workspace:* declaration and an exported subpath', () => {
  const declared = specifierSites(
    'packages/contracts/src/gesture.ts',
    "import { AppError } from '@agent-device/kernel/errors';",
  );
  assert.deepEqual(checkPackageInternalSites(contracts, declared, ALL), []);

  const undeclared = specifierSites(
    'packages/kernel/src/errors.ts',
    "import { g } from '@agent-device/contracts/gesture';",
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
  const repoRoot = path.resolve(import.meta.dirname, '../..');
  const packages = readWorkspacePackages(repoRoot);
  assert.ok(packages.length >= 1, 'expected at least the kernel package');
  const kernelPackage = packages.find((pkg) => pkg.name === '@agent-device/kernel');
  assert.ok(kernelPackage, 'kernel package must exist');
  assert.ok(kernelPackage.exportTargets.size >= 8, 'kernel exports its vocabulary subpaths');
  assert.ok(
    rootWorkspaceDependencyNames(repoRoot).has('@agent-device/kernel'),
    'root must declare the kernel workspace dependency',
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
  ]) {
    assert.throws(
      () => import.meta.resolve(deep),
      /ERR_PACKAGE_PATH_NOT_EXPORTED|Package subpath|No "exports" main/,
      `${deep} must not resolve`,
    );
  }
});
