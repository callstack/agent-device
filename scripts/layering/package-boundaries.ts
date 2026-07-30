// R11 package-boundaries: the workspace rules of #1490, as data the gate walks.
//
// Package resolution already makes a deep `@agent-device/*` specifier a runtime
// resolution error; these checks close the bypasses resolution alone cannot see:
// a package reaching back into root `src/`, a root file tunnelling into
// `packages/*/src` with a relative path, an import of a workspace package the
// manifest never declared, and a specifier subpath the owning `exports` map
// does not name.
//
// The single tolerated relative route into a package is an R8 zero-dep script
// importing an exports-named source target. That exception is exactly
// co-extensive with safety: Node's ESM loader does not realpath specifiers, so
// a module loaded BOTH relatively and via its package specifier instantiates
// twice in one process (duplicate AppError, broken instanceof). A zero-dep
// closure can never coexist with specifier loads — no node_modules — which is
// the only reason the exception exists at all. Production src/test files never
// qualify.

import fs from 'node:fs';
import path from 'node:path';
import { parseImports } from './model.ts';

export type PackageBoundaryViolation = {
  rule: string;
  file: string;
  line: number;
  message: string;
};

export type WorkspacePackage = {
  /** Repo-relative package dir, e.g. `packages/kernel`. */
  dir: string;
  name: string;
  /** Full import specifier -> repo-relative source target, from `exports`. */
  exportTargets: ReadonlyMap<string, string>;
  /** Declared `workspace:*` dependencies on sibling internal packages. */
  workspaceDependencies: ReadonlySet<string>;
};

export type SpecifierSite = {
  file: string;
  line: number;
  specifier: string;
};

/**
 * Every import specifier in `source`, with its 1-based line — through the
 * layering model's own parser, so static/dynamic/side-effect/re-export sites
 * and both quote styles are covered by one scanner instead of a private regex
 * that silently missed double-quoted routes.
 */
export function specifierSites(file: string, source: string): SpecifierSite[] {
  return parseImports(source).map((edge) => ({ file, line: edge.line, specifier: edge.spec }));
}

export function readWorkspacePackages(repoRoot: string): WorkspacePackage[] {
  const packagesDir = path.join(repoRoot, 'packages');
  if (!fs.existsSync(packagesDir)) return [];
  const packages: WorkspacePackage[] = [];
  for (const entry of fs.readdirSync(packagesDir).sort()) {
    const manifestPath = path.join(packagesDir, entry, 'package.json');
    if (!fs.existsSync(manifestPath)) continue;
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as {
      name?: string;
      private?: boolean;
      exports?: Record<string, { default?: string } | string>;
      dependencies?: Record<string, string>;
    };
    if (!manifest.name) continue;
    const exportTargets = new Map<string, string>();
    for (const [subpath, target] of Object.entries(manifest.exports ?? {})) {
      const targetFile = typeof target === 'string' ? target : target.default;
      if (!targetFile) continue;
      exportTargets.set(
        path.posix.join(manifest.name, subpath),
        path.posix.join('packages', entry, path.posix.normalize(targetFile)),
      );
    }
    const workspaceDependencies = new Set(
      Object.entries(manifest.dependencies ?? {})
        .filter(([, range]) => range.startsWith('workspace:'))
        .map(([name]) => name),
    );
    packages.push({
      dir: `packages/${entry}`,
      name: manifest.name,
      exportTargets,
      workspaceDependencies,
    });
  }
  return packages;
}

function packageByName(packages: readonly WorkspacePackage[], name: string) {
  return packages.find((pkg) => pkg.name === name);
}

function specifierPackageName(specifier: string): string | undefined {
  const match = /^(@[^/]+\/[^/]+)/.exec(specifier);
  return match?.[1];
}

/**
 * Rules for files INSIDE a package: no relative escape past the package dir;
 * exported package self-references are legal; any sibling-package import must
 * be declared `workspace:*`; and every package specifier must name an export.
 */
export function checkPackageInternalSites(
  pkg: WorkspacePackage,
  sites: readonly SpecifierSite[],
  allPackages: readonly WorkspacePackage[],
): PackageBoundaryViolation[] {
  const violations: PackageBoundaryViolation[] = [];
  for (const site of sites) {
    if (site.specifier.startsWith('.')) {
      const resolved = path.posix.normalize(
        path.posix.join(path.posix.dirname(site.file), site.specifier),
      );
      if (!resolved.startsWith(`${pkg.dir}/`)) {
        violations.push({
          rule: 'R11 package-boundaries',
          file: site.file,
          line: site.line,
          message:
            `'${site.specifier}' escapes ${pkg.dir}/ — a workspace package may not reach root ` +
            `code. Depend on another package's specifier, or move the shared code below this package.`,
        });
      }
      continue;
    }
    const name = specifierPackageName(site.specifier);
    if (!name || !name.startsWith('@agent-device/')) continue;
    const target = packageByName(allPackages, name);
    if (!target) {
      violations.push({
        rule: 'R11 package-boundaries',
        file: site.file,
        line: site.line,
        message: `'${site.specifier}' names an unknown workspace package.`,
      });
      continue;
    }
    if (name !== pkg.name && !pkg.workspaceDependencies.has(name)) {
      violations.push({
        rule: 'R11 package-boundaries',
        file: site.file,
        line: site.line,
        message:
          `${pkg.name} imports '${site.specifier}' without declaring "${name}": "workspace:*" ` +
          `in ${pkg.dir}/package.json dependencies.`,
      });
    }
    if (!target.exportTargets.has(site.specifier)) {
      violations.push({
        rule: 'R11 package-boundaries',
        file: site.file,
        line: site.line,
        message:
          `'${site.specifier}' is not named by ${target.dir}/package.json#exports — import an ` +
          `exported subpath or earn a new one with a real consumer.`,
      });
    }
  }
  return violations;
}

/**
 * Rules for files OUTSIDE packages/ (src, test, scripts): workspace specifiers
 * must be root-declared and exports-named; relative paths into `packages/·/src`
 * are forbidden except the R8 zero-dep exception — a `scripts/` file importing
 * an exports-named source target.
 */
export function checkRootSites(
  sites: readonly SpecifierSite[],
  packages: readonly WorkspacePackage[],
  rootWorkspaceDependencies: ReadonlySet<string>,
  zeroDepClosureFiles: ReadonlySet<string>,
): PackageBoundaryViolation[] {
  const violations: PackageBoundaryViolation[] = [];
  const exportedSources = new Set(packages.flatMap((pkg) => [...pkg.exportTargets.values()]));
  for (const site of sites) {
    if (site.specifier.startsWith('.')) {
      const resolved = path.posix.normalize(
        path.posix.join(path.posix.dirname(site.file), site.specifier),
      );
      if (!/^packages\/[^/]+\//.test(resolved)) continue;
      // The R8 exception requires BOTH membership in an actual zero-dep job
      // closure (no node_modules -> no coexisting specifier loads -> no dual
      // instantiation) AND an exports-named target. `scripts/` placement alone
      // proves neither.
      const inZeroDepClosure = zeroDepClosureFiles.has(site.file);
      if (inZeroDepClosure && exportedSources.has(resolved)) continue;
      violations.push({
        rule: 'R11 package-boundaries',
        file: site.file,
        line: site.line,
        message: inZeroDepClosure
          ? `'${site.specifier}' targets a non-exported package source — the R8 exception only ` +
            `covers files named by the package's exports map.`
          : `'${site.specifier}' bypasses the package boundary — import the package specifier ` +
            `instead. The relative route is reserved for files inside an R8 zero-dep job ` +
            `closure; anywhere else, dual specifier/relative loads would instantiate the ` +
            `module twice.`,
      });
      continue;
    }
    const name = specifierPackageName(site.specifier);
    if (!name || !name.startsWith('@agent-device/')) continue;
    const target = packageByName(packages, name);
    if (!target) {
      violations.push({
        rule: 'R11 package-boundaries',
        file: site.file,
        line: site.line,
        message: `'${site.specifier}' names an unknown workspace package.`,
      });
      continue;
    }
    if (!rootWorkspaceDependencies.has(name)) {
      violations.push({
        rule: 'R11 package-boundaries',
        file: site.file,
        line: site.line,
        message:
          `'${site.specifier}' is used but "${name}" is not a "workspace:*" entry in the root ` +
          `package.json devDependencies.`,
      });
    }
    if (!target.exportTargets.has(site.specifier)) {
      violations.push({
        rule: 'R11 package-boundaries',
        file: site.file,
        line: site.line,
        message:
          `'${site.specifier}' is not named by ${target.dir}/package.json#exports — deep imports ` +
          `into package internals are a resolution error; import an exported subpath.`,
      });
    }
  }
  return violations;
}

/** Root-manifest `workspace:*` names, from dependencies + devDependencies. */
export function rootWorkspaceDependencyNames(repoRoot: string): Set<string> {
  const manifest = JSON.parse(fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf8')) as {
    dependencies?: Record<string, string>;
    devDependencies?: Record<string, string>;
  };
  return new Set(
    Object.entries({ ...manifest.dependencies, ...manifest.devDependencies })
      .filter(([, range]) => range.startsWith('workspace:'))
      .map(([name]) => name),
  );
}

function walkTsFiles(repoRoot: string, relativeDir: string): string[] {
  const absolute = path.join(repoRoot, relativeDir);
  if (!fs.existsSync(absolute)) return [];
  const files: string[] = [];
  const queue = [absolute];
  while (queue.length > 0) {
    const dir = queue.pop()!;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name !== 'node_modules' && entry.name !== 'dist-types') queue.push(full);
      } else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.d.ts')) {
        files.push(path.relative(repoRoot, full).replaceAll(path.sep, '/'));
      }
    }
  }
  return files.sort();
}

/** Flat `specifier -> repo-relative source` map across all workspace packages. */
export function workspaceSpecifierTargets(repoRoot: string): Map<string, string> {
  const targets = new Map<string, string>();
  for (const pkg of readWorkspacePackages(repoRoot)) {
    for (const [specifier, target] of pkg.exportTargets) targets.set(specifier, target);
  }
  return targets;
}

/** The real-tree R11 run used by check.ts. */
export function checkPackageBoundaries(
  repoRoot: string,
  zeroDepClosure: ReadonlySet<string>,
): PackageBoundaryViolation[] {
  const packages = readWorkspacePackages(repoRoot);
  if (packages.length === 0) return [];
  const rootDependencies = rootWorkspaceDependencyNames(repoRoot);
  const violations: PackageBoundaryViolation[] = [];
  for (const pkg of packages) {
    for (const file of walkTsFiles(repoRoot, pkg.dir)) {
      const source = fs.readFileSync(path.join(repoRoot, file), 'utf8');
      violations.push(...checkPackageInternalSites(pkg, specifierSites(file, source), packages));
    }
  }
  for (const root of ['src', 'test', 'scripts']) {
    for (const file of walkTsFiles(repoRoot, root)) {
      // Gate tests under scripts/ carry import syntax inside fixture strings
      // (same reason R8 parses module records instead of scanning lines);
      // src/ and test/ suites stay covered — they import packages for real.
      if (root === 'scripts' && file.endsWith('.test.ts')) continue;
      const source = fs.readFileSync(path.join(repoRoot, file), 'utf8');
      violations.push(
        ...checkRootSites(specifierSites(file, source), packages, rootDependencies, zeroDepClosure),
      );
    }
  }
  return violations;
}

/** Success-line fragment for check.ts's report. */
export function packageBoundariesSummary(repoRoot: string): string {
  const packages = readWorkspacePackages(repoRoot);
  const exported = packages.reduce((sum, pkg) => sum + pkg.exportTargets.size, 0);
  return (
    `R11 holds ${packages.length} workspace package(s) behind ${exported} exported subpath(s) ` +
    `with zero root back-imports`
  );
}
