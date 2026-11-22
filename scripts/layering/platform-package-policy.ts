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
import { DAEMON_SOURCE_ROOT, isProductionSourceFile } from './tracked-sources.ts';
import { PLATFORMS } from '@agent-device/kernel/device';
import { parseImports, type LayeringViolation } from './model.ts';
import {
  HOST_KIT_EXEC_ROOTS,
  HOST_KIT_SPECIFIER_PREFIX,
  hostKitSources,
  hostKitPublicEntries,
  hostKitSymbolsReachingExec,
  indexHostKitReach,
  resolveRelativeSource,
  type HostKitReachIndex,
} from './host-kit-runtime-reach.ts';
import { staleReachModules } from './process-reach.ts';
import {
  APPLE_RUNNER_DIR,
  APPLE_RUNNER_PACKAGE,
  appleRunnerEntryImporterViolations,
  appleRunnerPackageSiteViolations,
} from './apple-runner-package-policy.ts';
import { checkPlatformComposition } from './platform-composition-policy.ts';
import { checkPlatformPackageSourcePolicy } from './platform-package-source-policy.ts';
import { isTestOnlyExportSpecifier } from './package-export-surface.ts';
import { retiredPathViolations } from './retired-zone-policy.ts';

export const CANONICAL_PLATFORM_FAMILIES = PLATFORMS;
type PlatformFamily = (typeof CANONICAL_PLATFORM_FAMILIES)[number];
export type PlatformPackageDeclaration = {
  dir: string;
  family: string;
  name: string;
  private: boolean;
  managedClaim?: { platform?: unknown; apiVersion?: unknown; appleOs?: unknown };
  publishedSubpaths?: readonly string[];
  exportedSubpaths: readonly string[];
};
const COMPOSITION_FILE = 'src/platform-runtime.ts';
const REQUEST_PROVIDER_COMPOSITION_FILE = 'src/platform-runtime/request-providers.ts';
const COMPOSITION_FILES = new Set([COMPOSITION_FILE, REQUEST_PROVIDER_COMPOSITION_FILE]);
const RULE = 'R13 platform-package-substrate';
const RAW_PROCESS_SPECIFIERS = new Set(['child_process', 'node:child_process']);
const PLATFORM_RUNTIME_HOST_FILES = new Set([
  'src/platform-runtime-audio-probe-host.ts',
  'src/platform-runtime-host-diagnostics.ts',
  'src/platform-runtime-managed-web-backend.ts',
  'src/platform-runtime-network-web-transport.ts',
  'src/platform-runtime-operation-host.ts',
  'src/platform-runtime-perf-host.ts',
  'src/platform-runtime-resource-cleanup.ts',
  'src/platform-runtime-screen-recording-web-host.ts',
  'src/platform-runtime-toolchain-host.ts',
]);

// #2040: the Apple XCUITest runner client is a platform-owned implementation
// facet. It lives in its own workspace package, '@agent-device/apple-runner', so it falls
// outside the `platform-*` name match; this module polices it as the Apple-family runner
// engine (one engine, not a per-OS split), not as a platform family of its own. Its single
// entry is reachable from platform-apple's composition and from the named root consumers
// below; platform-apple's own `runner/operations` and `runner-owner` subpaths remain the
// enumerated seam through which daemon/root consumers reach the host-bound operations (the
// runner-consumer migration behind the composition gateway has no owner today; if one retires
// those direct consumers, the seam narrows with it — the facet itself is durable Apple
// ownership, not a temporary exception).

export function checkRetiredPlatformsZone(files: readonly string[]): LayeringViolation[] {
  return retiredPathViolations(
    files,
    'src/platforms',
    'retired-platforms-zone',
    'src/platforms is retired; family code belongs in its platform package, shared mechanics in an owning substrate package, and cross-family tests in their root or package test owner',
  );
}
const APPLE_RUNNER_TEST_HOST_FILE = 'packages/apple-runner/src/test-host';
const ANDROID_MECHANICS_FACADE = '@agent-device/platform-android/mechanics';
const ANDROID_HOST_FACET = '@agent-device/platform-android/adb-host';
// The host port is bound by the root; daemon composition registers the helper's runtime state.
const ANDROID_HOST_FACET_IMPORTERS: ReadonlySet<string> = new Set([
  'src/platform-runtime-android-adb-host.ts',
  'src/daemon-composition.ts',
  'src/daemon-composition.test.ts',
]);
const ANDROID_DEVICE_BOOT_FACADE = '@agent-device/platform-android/device-boot';
const MECHANICS_FACET_SUBPATHS: Readonly<Partial<Record<PlatformFamily, readonly string[]>>> = {
  apple: [
    '@agent-device/platform-apple/app-lifecycle',
    '@agent-device/platform-apple/app-resolution',
    '@agent-device/platform-apple/debug-symbols',
    '@agent-device/platform-apple/doctor',
    '@agent-device/platform-apple/install-artifact',
    '@agent-device/platform-apple/macos-desktop',
    '@agent-device/platform-apple/macos-leaf',
    '@agent-device/platform-apple/perf',
    '@agent-device/platform-apple/physical-device',
    '@agent-device/platform-apple/plist',
    '@agent-device/platform-apple/runner-owner',
    '@agent-device/platform-apple/runner/operations',
    '@agent-device/platform-apple/session-observation',
    '@agent-device/platform-apple/snapshot-source',
    '@agent-device/platform-apple/simctl',
    '@agent-device/platform-apple/simulator',
    '@agent-device/platform-apple/simulator-boot',
    '@agent-device/platform-apple/tool-provider',
  ],
  android: [ANDROID_HOST_FACET, ANDROID_MECHANICS_FACADE, ANDROID_DEVICE_BOOT_FACADE],
  web: ['@agent-device/platform-web/interactor'],
};
const MANAGED_PLATFORMS: Readonly<Partial<Record<PlatformFamily, string>>> = {
  web: '@agent-device/web',
  vega: '@agent-device/vega',
  harmonyos: '@agent-device/harmonyos',
  linux: '@agent-device/linux',
};

/**
 * The managed packages that hold a leaf of a bundled family instead of a family (#4675). macOS
 * desktop automation is the one leaf: the bundled Apple owner keeps the `apple` claim, and this
 * package holds `{ platform: 'apple', appleOs: 'macos' }`. A leaf package is keyed by its
 * `packages/platform-<leaf>` directory and obeys every rule a managed family package obeys: one
 * `./agent-device` entry, no sibling platform import, no host-kit export that reaches the exec or
 * diagnostics roots, and a metadata-eager façade.
 */
export const MANAGED_PLATFORM_LEAVES: Readonly<
  Record<string, Readonly<{ name: string; family: PlatformFamily; appleOs: string }>>
> = {
  macos: { name: '@agent-device/macos', family: 'apple', appleOs: 'macos' },
};

/** The managed package a `packages/platform-<owner>` directory holds, family or leaf. */
function managedPackageName(owner: string): string | undefined {
  return MANAGED_PLATFORMS[owner as PlatformFamily] ?? MANAGED_PLATFORM_LEAVES[owner]?.name;
}

const MANAGED_PACKAGE_NAMES: readonly string[] = [
  ...Object.values(MANAGED_PLATFORMS),
  ...Object.values(MANAGED_PLATFORM_LEAVES).map((leaf) => leaf.name),
];

/**
 * The host-kit surfaces a managed platform package may not reach at runtime. Which exported names of a
 * subpath are dangerous is not listed here: it is derived from the host-kit module graph by
 * `host-kit-runtime-reach.ts`, so an export that starts loading `internal/exec.ts` or
 * `internal/diagnostics.ts` — through its own import or through a new one added to a module it already
 * used — is caught without an entry being edited here.
 */

// No host-kit scope is listed: the rule is derived, so every scope is policed, `process`, `file`,
// `command`, `diagnostics`, `retry` and any scope added later.
//
// Why the graph decides this: a managed plugin is bundled with its own copy of host-kit, and the
// daemon's command-host and diagnostic scopes never enter that copy. A runtime import of a host-kit
// module that reaches the exec layer therefore answers with the daemon process environment, outside the
// request's captured environment and exec trace, and its diagnostics land in the bundle's own store
// rather than the request's log. A managed plugin binds to the `PlatformHost` its `setup` receives
// instead, whose `processes` facet answers those reads on the core's own copy.
//
// What stays importable is what the graph proves loads neither root: the path helpers and the plain
// filesystem helpers. Type-only edges are allowed anywhere — they cost the bundle nothing. The process
// scope, the retry scope, the command scope, the diagnostics scope and the lock helpers are all
// refused, including the ones that only answer `os.platform()` or wait on a timer: they are declared by
// a module that also declares a process tool, so the bundle loads the tool with them. A plugin asks its
// host what machine its commands run on, and paces itself with `node:timers/promises` the way the
// core's own host does.
const MANAGED_HOST_KIT_SCOPE_MESSAGE =
  ': those exports load internal/exec.ts or internal/diagnostics.ts through the bundled copy, so run ' +
  'the command, emit the diagnostic, read processes, or take the lock through the PlatformHost given to ' +
  'setup, which answers inside the request environment and exec trace';

function managedHostKitScopeViolations(
  file: string,
  site: {
    spec: string;
    line: number;
    typeOnly: boolean;
    symbols: readonly string[];
    typeSymbols?: readonly string[];
  },
  managedName: string,
  reach: HostKitReachIndex,
): LayeringViolation[] {
  if (site.typeOnly) return [];
  // A name written as `type` is erased, so it is not part of what the import loads.
  const bound = site.symbols.filter((name) => !(site.typeSymbols ?? []).includes(name));
  if (!site.spec.startsWith(HOST_KIT_SPECIFIER_PREFIX)) return [];
  const surface = reach.surfaces.get(site.spec);
  if (!surface) {
    // A host-kit subpath the host-kit sources do not contain resolves outside this repository, so the
    // bundled copy is unknown and the edge is refused rather than assumed pure.
    return [
      violation(
        file,
        site.line,
        `${managedName} may not import the host-kit '${site.spec}' scope at runtime: no such ` +
          `host-kit subpath exists to derive its exec reachability from${MANAGED_HOST_KIT_SCOPE_MESSAGE}`,
      ),
    ];
  }
  const reached = hostKitSymbolsReachingExec(surface, bound);
  if (reached.length === 0) return [];
  return [
    violation(
      file,
      site.line,
      `${managedName} may not import the host-kit '${site.spec}' scope at runtime ` +
        `(${[...reached].sort().join(', ')})` +
        MANAGED_HOST_KIT_SCOPE_MESSAGE,
    ),
  ];
}

const INTERACTOR_COMPOSITION_FILE = 'src/core/interactors/register-builtins.ts';

function isInteractorSubpathImport(
  file: string,
  site: { spec: string; dynamic: boolean },
  family: string,
): boolean {
  return (
    site.spec === `@agent-device/platform-${family}/interactor` &&
    (MECHANICS_FACET_SUBPATHS[family as PlatformFamily] ?? []).includes(site.spec) &&
    file === INTERACTOR_COMPOSITION_FILE &&
    site.dynamic
  );
}

function isAndroidFacetSubpathImport(file: string, specifier: string): boolean {
  if (specifier === ANDROID_HOST_FACET) return ANDROID_HOST_FACET_IMPORTERS.has(file);
  if (isPlatformTestOnlyImport(specifier)) return true;
  if (!(MECHANICS_FACET_SUBPATHS.android ?? []).includes(specifier)) return false;
  // The named facets are the implementation seam for root/core/SDK consumers. Daemon production
  // code still reaches platform behavior through the request-bound runtime gateway; tests may
  // import a facet to exercise the package-owned mechanics directly.
  return !file.startsWith(DAEMON_SOURCE_ROOT) || !isProductionSourceFile(file);
}

// Test-only subpaths (fixtures, the runner test host) are R83's: it holds the export list and
// bans production importers, so R13 neither requires nor polices them.
function isPlatformTestOnlyImport(specifier: string): boolean {
  return concretePlatformFamily(specifier) !== undefined && isTestOnlyExportSpecifier(specifier);
}

function isAppleFacadeSubpathImport(specifier: string): boolean {
  return (
    (MECHANICS_FACET_SUBPATHS.apple?.includes(specifier) ?? false) ||
    isPlatformTestOnlyImport(specifier)
  );
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

function resolvesToAppleRunnerTestHost(file: string, specifier: string): boolean {
  if (!specifier.startsWith('.')) return false;
  const resolved = path.posix.normalize(path.posix.join(path.posix.dirname(file), specifier));
  return resolved.replace(/\.ts$/, '') === APPLE_RUNNER_TEST_HOST_FILE;
}

function isPackageOwnedFacadeTest(file: string, family: string, specifier: string): boolean {
  return (
    file.startsWith(`packages/platform-${family}/`) &&
    (file.endsWith('.test.ts') || file.includes('/__tests__/')) &&
    specifier === `@agent-device/platform-${family}`
  );
}

// The web interactor reuses the selectors package's canonical positional-ref normalizer.
const WEB_SELECTORS_PRODUCTION_SUBPATH = '@agent-device/selectors/interaction-positionals';

function isWebPackageSelectorImport(file: string, family: string, specifier: string): boolean {
  if (family !== 'web' || !file.startsWith('packages/platform-web/')) return false;
  if (specifier === WEB_SELECTORS_PRODUCTION_SUBPATH) return true;
  return (
    (file.endsWith('.test.ts') || file.includes('/__tests__/')) &&
    specifier === '@agent-device/selectors'
  );
}

function isTestKitTestImport(file: string, specifier: string): boolean {
  return specifier === '@agent-device/test-kit' && !isProductionSourceFile(file);
}

function managedPlatformDeclarationFailures(
  declaration: PlatformPackageDeclaration,
  expectedName: string,
  // What the package's claim must name: its own family, or the family and leaf it narrows.
  claim: Readonly<{ platform: string; appleOs?: string }> = { platform: declaration.family },
): LayeringViolation[] {
  const file = `${declaration.dir}/package.json`;
  if (
    declaration.name !== expectedName ||
    declaration.managedClaim?.platform !== claim.platform ||
    declaration.managedClaim?.appleOs !== claim.appleOs ||
    declaration.managedClaim?.apiVersion !== 3 ||
    declaration.exportedSubpaths.length !== 1 ||
    declaration.exportedSubpaths[0] !== `${expectedName}/agent-device` ||
    declaration.publishedSubpaths?.length !== 1 ||
    declaration.publishedSubpaths[0] !== './agent-device'
  ) {
    return [
      violation(
        file,
        1,
        `Managed platform must declare its ${claim.appleOs === undefined ? 'family' : 'family leaf'} and export only ${expectedName}/agent-device`,
      ),
    ];
  }
  return [];
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
    const managedName = MANAGED_PLATFORMS[family];
    if (managedName) {
      violations.push(...managedPlatformDeclarationFailures(declaration, managedName));
      continue;
    }
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
    const productionSubpaths = declaration.exportedSubpaths.filter(
      (subpath) => !isTestOnlyExportSpecifier(subpath),
    );
    if (
      productionSubpaths.length !== expectedSubpaths.length ||
      expectedSubpaths.some((subpath) => !productionSubpaths.includes(subpath))
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
  for (const [leaf, { name, family, appleOs }] of Object.entries(MANAGED_PLATFORM_LEAVES)) {
    const expectedDir = `packages/platform-${leaf}`;
    const declaration = packages.find((pkg) => pkg.dir === expectedDir);
    if (!declaration) {
      violations.push(
        violation(expectedDir, 1, `missing managed platform leaf package ${expectedDir}`),
      );
      continue;
    }
    violations.push(
      ...managedPlatformDeclarationFailures(declaration, name, { platform: family, appleOs }),
    );
  }
  for (const declaration of packages) {
    if (!declaration.dir.startsWith('packages/platform-')) continue;
    const family = declaration.dir.slice('packages/platform-'.length);
    if (Object.hasOwn(MANAGED_PLATFORM_LEAVES, family)) continue;
    if (!(CANONICAL_PLATFORM_FAMILIES as readonly string[]).includes(family)) {
      violations.push(
        violation(declaration.dir, 1, `${declaration.dir} is not a canonical platform family`),
      );
    }
  }
  return violations;
}

function checkSource(
  file: string,
  source: string,
  hostKitReach: HostKitReachIndex,
): LayeringViolation[] {
  const violations: LayeringViolation[] = [];
  const ownerFamily = familyForPackageFile(file);
  // The Apple runner package is not a platform family: it owns its cache/lease files and usbmux
  // sockets (fs/net/os), so the ambient-host rules do not apply to it, and its own substrate rules
  // run per import site below.
  if (ownerFamily && isProductionSourceFile(file)) {
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
    if (resolvesToAppleRunnerTestHost(file, site.spec) && isProductionSourceFile(file)) {
      violations.push(
        violation(
          file,
          site.line,
          'apple-runner/src/test-host.ts binds the runner test dispatcher — only test files and __tests__ helpers may import it',
        ),
      );
    }
    if (file.startsWith(APPLE_RUNNER_DIR)) {
      violations.push(...appleRunnerPackageSiteViolations(file, site));
    }
    violations.push(...appleRunnerEntryImporterViolations(file, site));
    const managedImport = MANAGED_PACKAGE_NAMES.some(
      (name) => site.spec === name || site.spec.startsWith(name + '/'),
    );
    if (managedImport && isProductionSourceFile(file)) {
      violations.push(
        violation(
          file,
          site.line,
          'Load managed platform entries only through the plugin registry',
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
    if (
      importedFamily &&
      !COMPOSITION_FILES.has(file) &&
      // Named platform facades are the package's consumer seams. R11's
      // workspace-dependency declarations bound the importer set to the root
      // package.
      !isAppleFacadeSubpathImport(site.spec) &&
      !isAllowedPlatformRootImport(file, site, importedFamily) &&
      !isPackageOwnedFacadeTest(file, importedFamily, site.spec) &&
      !isAndroidFacetSubpathImport(file, site.spec) &&
      !isInteractorSubpathImport(file, site, importedFamily)
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
    const managedName = managedPackageName(ownerFamily);
    if (managedName && isProductionSourceFile(file)) {
      violations.push(...managedHostKitScopeViolations(file, site, managedName, hostKitReach));
    }
    if (
      site.spec.startsWith('@agent-device/') &&
      !site.spec.startsWith('@agent-device/contracts/') &&
      site.spec !== '@agent-device/capture-kit' &&
      !site.spec.startsWith('@agent-device/capture-kit/') &&
      !site.spec.startsWith('@agent-device/host-kit/') &&
      !site.spec.startsWith('@agent-device/gestures/') &&
      !site.spec.startsWith('@agent-device/provision-kit/') &&
      !site.spec.startsWith('@agent-device/kernel/') &&
      site.spec !== '@agent-device/xml' &&
      // platform-apple composes the Apple runner package; no other family may reach it.
      !(ownerFamily === 'apple' && site.spec === APPLE_RUNNER_PACKAGE) &&
      !isAppleFacadeSubpathImport(site.spec) &&
      !isPackageOwnedFacadeTest(file, ownerFamily, site.spec) &&
      !isWebPackageSelectorImport(file, ownerFamily, site.spec) &&
      !isTestKitTestImport(file, site.spec)
    ) {
      violations.push(
        violation(
          file,
          site.line,
          `platform-${ownerFamily} may import workspace code only from capture-kit, gestures, host-kit, provision-kit, contracts, kernel, or xml; found '${site.spec}'`,
        ),
      );
    }
    if (importedFamily && importedFamily !== ownerFamily) {
      violations.push(
        violation(file, site.line, `platform-${ownerFamily} may not import sibling '${site.spec}'`),
      );
    }
    const importsPluginTypes =
      managedPackageName(ownerFamily) && site.typeOnly && site.spec === 'agent-device/plugins';
    if (
      resolvesOutsidePackage(file, site.spec, ownerFamily) ||
      (/^agent-device(?:\/|$)/.test(site.spec) && !importsPluginTypes)
    ) {
      violations.push(
        violation(file, site.line, `platform-${ownerFamily} may not reach root or daemon code`),
      );
    }
    // Production value-imports only: package tests fake process primitives
    // (they intercept, not spawn), and the runner host port names ChildProcess
    // as a type. The spawn ban is about mechanics bypassing the host-command
    // port at runtime.
    if (RAW_PROCESS_SPECIFIERS.has(site.spec) && isProductionSourceFile(file) && !site.typeOnly) {
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
    !isProductionSourceFile(file) ||
    file.startsWith('src/core/interactors/') ||
    (PLATFORM_RUNTIME_HOST_FILES.has(file) && (site.dynamic || site.typeOnly))
  );
}

export function checkPlatformPackagePolicy(
  sources: ReadonlyMap<string, string>,
  packages: readonly PlatformPackageDeclaration[],
  options: {
    untrackedProductionFiles?: readonly string[];
    /**
     * The host-kit sources to derive exec reachability from. Defaults to the host-kit files `sources`
     * contains, which is what the gate passes; a caller that scans a slice injects its own.
     */
    hostKitSources?: ReadonlyMap<string, string>;
  } = {},
): LayeringViolation[] {
  // The host-kit files in the scan input are what the derivation walks. A scan slice without them
  // answers that no subpath can be proved pure, which refuses a managed plugin's host-kit import rather
  // than letting an absent graph pass it; the gate scan carries every host-kit source.
  const hostKit = options.hostKitSources ?? hostKitSources(sources);
  const hostKitReach = indexHostKitReach({
    sources: hostKit,
    entries: hostKitPublicEntries(hostKit),
    resolve: (fromFile, spec) => {
      const target = resolveRelativeSource(fromFile, spec);
      return target !== undefined && hostKit.has(target) ? target : undefined;
    },
  });
  return [
    ...(options.untrackedProductionFiles ?? []).map((file) =>
      violation(
        file,
        1,
        'untracked production source is not committed-state layering evidence; commit the complete slice before running the gate',
      ),
    ),
    // The roots the derivation walks are declared paths: a move of either would otherwise answer
    // "no export reaches the exec layer" for every managed plugin at once.
    ...(hostKit.size === 0
      ? []
      : staleReachModules(
          RULE,
          'packages/host-kit/package.json',
          HOST_KIT_EXEC_ROOTS,
          [...hostKit.keys()],
          'HOST_KIT_EXEC_ROOTS',
        )),
    ...checkDeclarations(packages),
    ...checkPlatformComposition(sources.get(COMPOSITION_FILE)),
    ...[...sources].flatMap(([file, source]) => checkSource(file, source, hostKitReach)),
  ];
}

export function platformPackagePolicySummary(): string {
  return `R13 holds built-in and managed implementation-lazy platform packages above capture-kit behind one canonical composition root and its single private provider-composition submodule, with the android mechanics facet and the Apple runner package behind their enumerated seams; deferred or type-only edges are limited to the approved platform-runtime host watchlist and the dynamic-only Web interactor subpath imported by ${INTERACTOR_COMPOSITION_FILE}`;
}
