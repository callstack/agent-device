import path from 'node:path';
import { parseImports, type LayeringViolation } from './model.ts';
import { checkPlatformComposition } from './platform-composition-policy.ts';
import { checkPlatformPackageSourcePolicy } from './platform-package-source-policy.ts';

export const CANONICAL_PLATFORM_FAMILIES = [
  'apple',
  'android',
  'harmonyos',
  'vega',
  'linux',
  'web',
] as const;
type PlatformFamily = (typeof CANONICAL_PLATFORM_FAMILIES)[number];
export type PlatformPackageDeclaration = {
  dir: string;
  family: string;
  name: string;
  private: boolean;
  exportedSubpaths: readonly string[];
};
const COMPOSITION_FILE = 'src/platform-runtime.ts';
const RULE = 'R13 platform-package-substrate';
const RAW_PROCESS_SPECIFIERS = new Set(['child_process', 'node:child_process']);

// #2040: the Apple XCUITest runner client is a platform-owned implementation
// facet colocated in platform-apple as the src/runner/ subtree. Its subpaths
// are the enumerated seam through which daemon/root consumers reach runner
// mechanics directly (the runner-consumer migration behind the composition
// gateway has no owner today; if one retires those direct consumers, the seam
// narrows with it — the facet itself is durable Apple ownership, not a
// temporary exception).
export const APPLE_RUNNER_SUBTREE = 'packages/platform-apple/src/runner/';
const APPLE_RUNNER_FACADE = '@agent-device/platform-apple/runner';
const APPLE_RUNNER_CLIENT = '@agent-device/platform-apple/runner/client';
const APPLE_RUNNER_TEST_HOST = '@agent-device/platform-apple/runner/test-host';
const APPLE_RUNNER_CLIENT_COMPOSITION = 'src/platforms/apple/core/runner-client.ts';
const APPLE_RUNNER_TEST_HOST_INSTALLER = 'scripts/vitest-apple-runner-host-setup.ts';
const MECHANICS_FACET_SUBPATHS: Readonly<Partial<Record<PlatformFamily, readonly string[]>>> = {
  apple: [APPLE_RUNNER_FACADE, APPLE_RUNNER_CLIENT, APPLE_RUNNER_TEST_HOST],
};

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

function concretePlatformFamily(specifier: string): string | undefined {
  return /^@agent-device\/platform-([^/]+)(?:\/|$)/.exec(specifier)?.[1];
}

function resolvesOutsidePackage(file: string, specifier: string, family: string): boolean {
  if (!specifier.startsWith('.')) return false;
  const resolved = path.posix.normalize(path.posix.join(path.posix.dirname(file), specifier));
  return !resolved.startsWith(`packages/platform-${family}/`);
}

function isPackageOwnedFacadeTest(file: string, family: string, specifier: string): boolean {
  return (
    file.startsWith(`packages/platform-${family}/`) &&
    (file.endsWith('.test.ts') || file.includes('/__tests__/')) &&
    specifier === `@agent-device/platform-${family}`
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
            (MECHANICS_FACET_SUBPATHS[family]
              ? ` plus the enumerated mechanics facet subpaths`
              : ''),
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
    if (site.spec === APPLE_RUNNER_CLIENT && file !== APPLE_RUNNER_CLIENT_COMPOSITION) {
      violations.push(
        violation(
          file,
          site.line,
          `'${APPLE_RUNNER_CLIENT}' is the host-bound runner client factory — only the composition root ${APPLE_RUNNER_CLIENT_COMPOSITION} may construct the client`,
        ),
      );
    } else if (site.spec === APPLE_RUNNER_TEST_HOST && file !== APPLE_RUNNER_TEST_HOST_INSTALLER) {
      violations.push(
        violation(
          file,
          site.line,
          `'${APPLE_RUNNER_TEST_HOST}' installs the runner test host dispatcher — only ${APPLE_RUNNER_TEST_HOST_INSTALLER} may import it`,
        ),
      );
    } else if (
      importedFamily &&
      file !== COMPOSITION_FILE &&
      // The runner façade subpath is the facet's consumer seam: root code
      // that reaches runner mechanics directly imports its types and host-free
      // helpers here. R11's workspace-dependency declarations bound the
      // importer set to the root package.
      site.spec !== APPLE_RUNNER_FACADE &&
      site.spec !== APPLE_RUNNER_CLIENT &&
      site.spec !== APPLE_RUNNER_TEST_HOST &&
      !isPackageOwnedFacadeTest(file, importedFamily, site.spec)
    ) {
      violations.push(
        violation(
          file,
          site.line,
          `only ${COMPOSITION_FILE} may import '${site.spec}' outside its package-owned tests`,
        ),
      );
    }
    if (!ownerFamily) continue;
    if (
      site.spec.startsWith('@agent-device/') &&
      !site.spec.startsWith('@agent-device/contracts/') &&
      site.spec !== '@agent-device/capture-kit' &&
      !site.spec.startsWith('@agent-device/capture-kit/') &&
      !site.spec.startsWith('@agent-device/kernel/') &&
      site.spec !== '@agent-device/xml' &&
      !isPackageOwnedFacadeTest(file, ownerFamily, site.spec)
    ) {
      violations.push(
        violation(
          file,
          site.line,
          `platform-${ownerFamily} may import workspace code only from capture-kit, contracts, kernel, or xml; found '${site.spec}'`,
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
  return 'R13 holds six private implementation-lazy platform packages above capture-kit behind one composition root, with the apple runner mechanics facet behind its enumerated seam';
}
