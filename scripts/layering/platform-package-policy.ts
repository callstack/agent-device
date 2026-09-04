// Catches: a platform package's private implementation loaded before the one canonical
//   composition root assembles it, or a cross-boundary edge into another platform family's
//   private surface — the six platform packages moved behind package facades (#2116-#2125)
//   specifically to make eager loading and cross-family reach-ins visible, and only a source
//   walk over every package's imports can confirm the boundary actually held.
// Evidence: 838ed223b5 (#2116) moved the six W6 platform families behind package facades;
//   ed26b31c94 (#2125) contracted the Apple platform surface to match.
// Cost: 1030 LOC (377 rule + 653 test); shared with platform-composition-policy.ts (103 LOC)
//   and platform-package-source-policy.ts (230 LOC), which this module orchestrates.
// Kill criterion: none enforced today; retire only by maintainer decision that platform-family
//   isolation (private manifests with exact exports, static imports only from the composition
//   root, no sibling-family reach-ins, no top-level loadInventory/loadRuntime) no longer
//   matters. Publishing the families separately would not replace it: the A4 spike found an
//   undeclared workspace package still resolves through root node_modules and a relative tunnel
//   into a sibling's src still compiles; project references are a build cache, not a boundary.

import path from 'node:path';
import { PLATFORMS } from '@agent-device/kernel/device';
import { parseImports, type LayeringViolation } from './model.ts';
import { checkPlatformComposition } from './platform-composition-policy.ts';
import { checkPlatformPackageSourcePolicy } from './platform-package-source-policy.ts';
import { retiredPathViolations } from './retired-zone-policy.ts';

export const CANONICAL_PLATFORM_FAMILIES = PLATFORMS;
type PlatformFamily = (typeof CANONICAL_PLATFORM_FAMILIES)[number];
export type PlatformPackageDeclaration = {
  dir: string;
  family: string;
  name: string;
  private: boolean;
  exportedSubpaths: readonly string[];
};
const COMPOSITION_FILE = 'src/platform-runtime.ts';
const REQUEST_PROVIDER_COMPOSITION_FILE = 'src/platform-runtime/request-providers.ts';
const COMPOSITION_FILES = new Set([COMPOSITION_FILE, REQUEST_PROVIDER_COMPOSITION_FILE]);
const RULE = 'R13 platform-package-substrate';
const RAW_PROCESS_SPECIFIERS = new Set(['child_process', 'node:child_process']);
const PLATFORM_RUNTIME_HOST_FILES = new Set([
  'src/platform-runtime-app-inventory-host.ts',
  'src/platform-runtime-app-state-host.ts',
  'src/platform-runtime-audio-probe-host.ts',
  'src/platform-runtime-host-diagnostics.ts',
  'src/platform-runtime-managed-web-backend.ts',
  'src/platform-runtime-network-web-transport.ts',
  'src/platform-runtime-operation-host.ts',
  'src/platform-runtime-perf-host.ts',
  'src/platform-runtime-resource-cleanup.ts',
  'src/platform-runtime-screen-recording-harmony-host.ts',
  'src/platform-runtime-screen-recording-web-host.ts',
  'src/platform-runtime-toolchain-host.ts',
]);

// #2040: the Apple XCUITest runner client is a platform-owned implementation
// facet colocated in platform-apple as the src/runner/ subtree. Its subpaths
// are the enumerated seam through which daemon/root consumers reach runner
// mechanics directly (the runner-consumer migration behind the composition
// gateway has no owner today; if one retires those direct consumers, the seam
// narrows with it — the facet itself is durable Apple ownership, not a
// temporary exception).
export const APPLE_RUNNER_SUBTREE = 'packages/platform-apple/src/runner/';

export function checkRetiredPlatformsZone(files: readonly string[]): LayeringViolation[] {
  return retiredPathViolations(
    files,
    'src/platforms',
    'retired-platforms-zone',
    'src/platforms is retired; family code belongs in its platform package, shared mechanics in an owning substrate package, and cross-family tests in their root or package test owner',
  );
}
const APPLE_RUNNER_FACADE = '@agent-device/platform-apple/runner';
const APPLE_RUNNER_TEST_HOST = '@agent-device/platform-apple/runner/test-host';
const APPLE_RUNNER_TEST_HOST_INSTALLER = 'scripts/vitest-apple-runner-host-setup.ts';
const ANDROID_MECHANICS_FACADE = '@agent-device/platform-android/mechanics';
const ANDROID_HOST_FACET = '@agent-device/platform-android/adb-host';
const ANDROID_HOST_BINDING = 'src/platform-runtime-android-adb-host.ts';
const MECHANICS_FACET_SUBPATHS: Readonly<Partial<Record<PlatformFamily, readonly string[]>>> = {
  apple: [
    APPLE_RUNNER_FACADE,
    APPLE_RUNNER_TEST_HOST,
    '@agent-device/platform-apple/app-lifecycle',
    '@agent-device/platform-apple/app-resolution',
    '@agent-device/platform-apple/debug-symbols',
    '@agent-device/platform-apple/doctor',
    '@agent-device/platform-apple/install-artifact',
    '@agent-device/platform-apple/macos',
    '@agent-device/platform-apple/perf',
    '@agent-device/platform-apple/physical-device',
    '@agent-device/platform-apple/runner-owner',
    '@agent-device/platform-apple/runner/operations',
    '@agent-device/platform-apple/snapshot-source',
    '@agent-device/platform-apple/simctl',
    '@agent-device/platform-apple/simulator',
    '@agent-device/platform-apple/tool-provider',
  ],
  android: [ANDROID_HOST_FACET, ANDROID_MECHANICS_FACADE],
};

function isAndroidMechanicsFacetImport(file: string, specifier: string): boolean {
  if (specifier === ANDROID_HOST_FACET) return file === ANDROID_HOST_BINDING;
  if (specifier !== ANDROID_MECHANICS_FACADE) return false;
  // The mechanics facet is the named implementation seam for root/core/SDK consumers. Daemon
  // production code still reaches platform behavior through the request-bound runtime gateway;
  // tests may import the facet to exercise the package-owned mechanics directly.
  return !file.startsWith('src/daemon/') || !isProductionSource(file);
}

function isAppleFacadeSubpathImport(specifier: string): boolean {
  return MECHANICS_FACET_SUBPATHS.apple?.includes(specifier) ?? false;
}

function violation(file: string, line: number, message: string): LayeringViolation {
  return { rule: RULE, file, line, message };
}

function packageName(family: PlatformFamily): string {
  return `@agent-device/platform-${family}`;
}

function packageDir(family: PlatformFamily): string {
  return `packages/platform-${family}`;
}

function familyForPackageFile(file: string): string | undefined {
  return /^packages\/platform-([^/]+)\//.exec(file)?.[1];
}

function isProductionSource(file: string): boolean {
  return !file.endsWith('.test.ts') && !file.includes('/__tests__/');
}

function isNonProductionConsumer(file: string): boolean {
  return !isProductionSource(file) || file.startsWith('test/');
}

function concretePlatformFamily(specifier: string): string | undefined {
  return /^@agent-device\/platform-([^/]+)(?:\/|$)/.exec(specifier)?.[1];
}

function resolvesOutsidePackage(file: string, specifier: string, family: string): boolean {
  if (!specifier.startsWith('.')) return false;
  const resolved = path.posix.normalize(path.posix.join(path.posix.dirname(file), specifier));
  return !resolved.startsWith(`packages/platform-${family}/`);
}

function resolvesToRequestProviderComposition(file: string, specifier: string): boolean {
  if (!specifier.startsWith('.')) return false;
  const resolved = path.posix.normalize(path.posix.join(path.posix.dirname(file), specifier));
  return resolved === REQUEST_PROVIDER_COMPOSITION_FILE;
}

function isPackageOwnedFacadeTest(file: string, family: string, specifier: string): boolean {
  return (
    file.startsWith(`packages/platform-${family}/`) &&
    (file.endsWith('.test.ts') || file.includes('/__tests__/')) &&
    specifier === `@agent-device/platform-${family}`
  );
}

function isWebPackageTestSelectorImport(file: string, family: string, specifier: string): boolean {
  return (
    family === 'web' &&
    file.startsWith('packages/platform-web/') &&
    (file.endsWith('.test.ts') || file.includes('/__tests__/')) &&
    specifier === '@agent-device/selectors'
  );
}

function checkDeclarations(packages: readonly PlatformPackageDeclaration[]): LayeringViolation[] {
  const violations: LayeringViolation[] = [];
  for (const family of CANONICAL_PLATFORM_FAMILIES) {
    const expectedDir = packageDir(family);
    const matches = packages.filter((pkg) => pkg.dir === expectedDir);
    if (matches.length === 0) {
      violations.push(
        violation(expectedDir, 1, `missing canonical platform package ${expectedDir}`),
      );
      continue;
    }
    if (matches.length > 1) {
      violations.push(violation(expectedDir, 1, `${expectedDir} is declared more than once`));
      continue;
    }
    const declaration = matches[0]!;
    const expectedName = packageName(family);
    if (declaration.name !== expectedName) {
      violations.push(
        violation(
          `${expectedDir}/package.json`,
          1,
          `${expectedDir} must be named '${expectedName}', found '${declaration.name}'`,
        ),
      );
    }
    if (!declaration.private) {
      violations.push(
        violation(`${expectedDir}/package.json`, 1, `${expectedDir} must be private`),
      );
    }
    const expectedSubpaths = [expectedName, ...(MECHANICS_FACET_SUBPATHS[family] ?? [])];
    if (
      declaration.exportedSubpaths.length !== expectedSubpaths.length ||
      expectedSubpaths.some((subpath) => !declaration.exportedSubpaths.includes(subpath))
    ) {
      violations.push(
        violation(
          `${expectedDir}/package.json`,
          1,
          `${expectedDir} must export exactly its root façade '${expectedName}'` +
            (expectedSubpaths.length > 1 ? ` plus its enumerated mechanics subpaths` : ''),
        ),
      );
    }
  }
  for (const declaration of packages) {
    if (!declaration.dir.startsWith('packages/platform-')) continue;
    const family = declaration.dir.slice('packages/platform-'.length);
    if (!(CANONICAL_PLATFORM_FAMILIES as readonly string[]).includes(family)) {
      violations.push(
        violation(declaration.dir, 1, `${declaration.dir} is not a canonical platform family`),
      );
    }
  }
  return violations;
}

function checkSource(file: string, source: string): LayeringViolation[] {
  const violations: LayeringViolation[] = [];
  const ownerFamily = familyForPackageFile(file);
  // The runner mechanics facet owns its cache/lease files and usbmux sockets
  // (fs/net/os) and reads process identity directly — that ownership is part
  // of the facet's definition, so the ambient-host rules do not apply to it.
  // Raw process primitives stay banned below and host tooling still enters
  // through the AppleRunnerHost port.
  if (ownerFamily && isProductionSource(file) && !file.startsWith(APPLE_RUNNER_SUBTREE)) {
    violations.push(...checkPlatformPackageSourcePolicy(file, source, ownerFamily));
  }
  for (const site of parseImports(source)) {
    if (resolvesToRequestProviderComposition(file, site.spec) && file !== COMPOSITION_FILE) {
      violations.push(
        violation(
          file,
          site.line,
          `only ${COMPOSITION_FILE} may import the private request-provider composition submodule`,
        ),
      );
    }
    const importedFamily = concretePlatformFamily(site.spec);
    if (file.startsWith('packages/contracts/') && importedFamily) {
      violations.push(
        violation(
          file,
          site.line,
          `contracts may never import a concrete platform package ('${site.spec}')`,
        ),
      );
    }
    if (file.startsWith('packages/provision-kit/') && importedFamily) {
      violations.push(
        violation(
          file,
          site.line,
          `only ${COMPOSITION_FILE} or its governed request-provider composition submodule may import '${site.spec}' outside its package-owned tests`,
        ),
      );
    }
    if (site.spec === APPLE_RUNNER_TEST_HOST && file !== APPLE_RUNNER_TEST_HOST_INSTALLER) {
      violations.push(
        violation(
          file,
          site.line,
          `'${APPLE_RUNNER_TEST_HOST}' installs the runner test host dispatcher — only ${APPLE_RUNNER_TEST_HOST_INSTALLER} may import it`,
        ),
      );
    } else if (
      importedFamily &&
      !COMPOSITION_FILES.has(file) &&
      // Named platform facades are the package's consumer seams. R11's
      // workspace-dependency declarations bound the importer set to the root
      // package.
      !isAppleFacadeSubpathImport(site.spec) &&
      !isAllowedPlatformRootImport(file, site, importedFamily) &&
      !isPackageOwnedFacadeTest(file, importedFamily, site.spec) &&
      !isAndroidMechanicsFacetImport(file, site.spec)
    ) {
      violations.push(
        violation(
          file,
          site.line,
          site.spec === `@agent-device/platform-${importedFamily}`
            ? `production static imports of '${site.spec}' are limited to ${COMPOSITION_FILE} and src/core/interactors/; other value edges require a deferred import from an approved platform-runtime host file`
            : `only ${COMPOSITION_FILE} or its governed request-provider composition submodule may import '${site.spec}' outside its package-owned tests`,
        ),
      );
    }
    if (!ownerFamily) continue;
    if (
      site.spec.startsWith('@agent-device/') &&
      !site.spec.startsWith('@agent-device/contracts/') &&
      site.spec !== '@agent-device/capture-kit' &&
      !site.spec.startsWith('@agent-device/capture-kit/') &&
      !site.spec.startsWith('@agent-device/host-kit/') &&
      !site.spec.startsWith('@agent-device/provision-kit/') &&
      !site.spec.startsWith('@agent-device/kernel/') &&
      site.spec !== '@agent-device/xml' &&
      !isAppleFacadeSubpathImport(site.spec) &&
      !isPackageOwnedFacadeTest(file, ownerFamily, site.spec) &&
      !isWebPackageTestSelectorImport(file, ownerFamily, site.spec)
    ) {
      violations.push(
        violation(
          file,
          site.line,
          `platform-${ownerFamily} may import workspace code only from capture-kit, host-kit, provision-kit, contracts, kernel, or xml; found '${site.spec}'`,
        ),
      );
    }
    if (importedFamily && importedFamily !== ownerFamily) {
      violations.push(
        violation(file, site.line, `platform-${ownerFamily} may not import sibling '${site.spec}'`),
      );
    }
    if (
      resolvesOutsidePackage(file, site.spec, ownerFamily) ||
      /^agent-device(?:\/|$)/.test(site.spec)
    ) {
      violations.push(
        violation(file, site.line, `platform-${ownerFamily} may not reach root or daemon code`),
      );
    }
    // Production value-imports only: package tests fake process primitives
    // (they intercept, not spawn), and the runner host port names ChildProcess
    // as a type. The spawn ban is about mechanics bypassing the host-command
    // port at runtime.
    if (RAW_PROCESS_SPECIFIERS.has(site.spec) && isProductionSource(file) && !site.typeOnly) {
      violations.push(
        violation(
          file,
          site.line,
          `platform-${ownerFamily} may not import raw process primitives ('${site.spec}'); use the host-command port`,
        ),
      );
    }
    if (
      file === `packages/platform-${ownerFamily}/src/index.ts` &&
      !site.dynamic &&
      !site.typeOnly
    ) {
      violations.push(
        violation(
          file,
          site.line,
          `platform-${ownerFamily} facade must not eagerly evaluate '${site.spec}'`,
        ),
      );
    }
  }
  return violations;
}

function isAllowedPlatformRootImport(
  file: string,
  site: { spec: string; dynamic: boolean; typeOnly: boolean },
  family: string,
): boolean {
  if (site.spec !== `@agent-device/platform-${family}`) return false;
  return (
    isNonProductionConsumer(file) ||
    file.startsWith('src/core/interactors/') ||
    (PLATFORM_RUNTIME_HOST_FILES.has(file) && (site.dynamic || site.typeOnly))
  );
}

export function checkPlatformPackagePolicy(
  sources: ReadonlyMap<string, string>,
  packages: readonly PlatformPackageDeclaration[],
  options: { untrackedProductionFiles?: readonly string[] } = {},
): LayeringViolation[] {
  return [
    ...(options.untrackedProductionFiles ?? []).map((file) =>
      violation(
        file,
        1,
        'untracked production source is not committed-state layering evidence; commit the complete slice before running the gate',
      ),
    ),
    ...checkDeclarations(packages),
    ...checkPlatformComposition(sources.get(COMPOSITION_FILE)),
    ...[...sources].flatMap(([file, source]) => checkSource(file, source)),
  ];
}

export function platformPackagePolicySummary(): string {
  return 'R13 holds six private implementation-lazy platform packages above capture-kit behind one canonical composition root and its single private provider-composition submodule, with the apple runner and android mechanics facets behind their enumerated seams; deferred or type-only edges are limited to the approved platform-runtime host watchlist';
}
