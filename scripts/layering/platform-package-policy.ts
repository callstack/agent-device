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
    if (
      declaration.exportedSubpaths.length !== 1 ||
      declaration.exportedSubpaths[0] !== expectedName
    ) {
      violations.push(
        violation(
          `${expectedDir}/package.json`,
          1,
          `${expectedDir} must export only its root façade '${expectedName}'`,
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
  if (ownerFamily && isProductionSource(file)) {
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
    if (
      importedFamily &&
      file !== COMPOSITION_FILE &&
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
      !isPackageOwnedFacadeTest(file, ownerFamily, site.spec)
    ) {
      violations.push(
        violation(
          file,
          site.line,
          `platform-${ownerFamily} may import workspace code only from capture-kit, contracts, or kernel; found '${site.spec}'`,
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
    if (RAW_PROCESS_SPECIFIERS.has(site.spec)) {
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
  return 'R13 holds six private implementation-lazy platform packages above capture-kit behind one composition root';
}
