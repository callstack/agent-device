// R11 package-boundaries: the workspace rules of #1490, as data the gate walks.
//
// Package resolution already makes a deep `@agent-device/*` specifier a runtime
// resolution error; these checks close the bypasses resolution alone cannot see:
// a package reaching back into root `src/`, a root file tunnelling into
// `packages/*/src` with a relative path, an import of a workspace package the
// manifest never declared, and a specifier subpath the owning `exports` map
// does not name.
//
// No relative route into a package is tolerated. Node's ESM loader does not
// realpath specifiers, so a module loaded BOTH relatively and via its package
// specifier instantiates twice in one process (duplicate AppError, broken
// instanceof). The one exception this rule used to grant — a file inside an R8
// zero-dep job closure, where no node_modules means specifier loads cannot
// coexist — retired with R8 itself (#1781 A6), because the repo runs no
// `install-deps: false` job for it to cover.

import fs from 'node:fs';
import path from 'node:path';
import { parseImports } from './model.ts';
import { listTrackedPackageManifests, listTrackedProductionSources } from './tracked-sources.ts';

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
  /** Non-workspace dependencies that the root build must externalize. */
  externalDependencies: ReadonlyMap<string, string>;
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

/**
 * Every workspace package a gate may reason about, read from TRACKED manifests only.
 *
 * A `readdirSync` of `packages/` would also pick up a directory a contributor created but never
 * committed, and its `exports` map would then contribute entry surfaces to R11 and to the
 * ADR-0019 loading-shape budgets -- gates whose whole claim is that they describe committed state
 * (#1965 review). R13's `readTrackedPlatformPackageDeclarations` already enumerated its manifests
 * this way; this closes the same hole for every workspace package, at the source rather than by
 * filtering the output.
 */
export function readWorkspacePackages(repoRoot: string): WorkspacePackage[] {
  const packages: WorkspacePackage[] = [];
  for (const manifestFile of listTrackedPackageManifests(repoRoot).sort()) {
    const entry = path.posix.basename(path.posix.dirname(manifestFile));
    const manifestPath = path.join(repoRoot, manifestFile);
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
    const externalDependencies = new Map(
      Object.entries(manifest.dependencies ?? {}).filter(
        ([, range]) => !range.startsWith('workspace:'),
      ),
    );
    packages.push({
      dir: `packages/${entry}`,
      name: manifest.name,
      exportTargets,
      workspaceDependencies,
      externalDependencies,
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
 * must be root-declared and exports-named, and relative paths into
 * `packages/·/src` are forbidden outright.
 */
export function checkRootSites(
  sites: readonly SpecifierSite[],
  packages: readonly WorkspacePackage[],
  rootWorkspaceDependencies: ReadonlySet<string>,
): PackageBoundaryViolation[] {
  const violations: PackageBoundaryViolation[] = [];
  for (const site of sites) {
    if (site.specifier.startsWith('.')) {
      const resolved = path.posix.normalize(
        path.posix.join(path.posix.dirname(site.file), site.specifier),
      );
      if (!/^packages\/[^/]+\//.test(resolved)) continue;
      violations.push({
        rule: 'R11 package-boundaries',
        file: site.file,
        line: site.line,
        message:
          `'${site.specifier}' bypasses the package boundary — import the package specifier ` +
          `instead, or dual specifier/relative loads instantiate the module twice.`,
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

/** Root runtime dependency ranges used by the published bundle. */
export function rootExternalDependencyRanges(repoRoot: string): Map<string, string> {
  const manifest = JSON.parse(fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf8')) as {
    dependencies?: Record<string, string>;
  };
  return new Map(Object.entries(manifest.dependencies ?? {}));
}

/**
 * Every workspace-package entry surface, repo-root-relative and sorted: whatever a package
 * manifest's `exports` map points at, plus every production source file under a `src/facades/`
 * directory.
 *
 * The single owner of that question. R11's façade gates and the ADR-0019 eager-closure budget
 * table (`scripts/__tests__/eager-closure-budgets.ts`) both consume this, so the two cannot drift
 * into disagreeing about what counts as a façade — a gate that scanned a narrower set would
 * silently exempt files the other one covers, which is exactly the hole #1960 review found (a
 * one-level `readdir` missed both nested façade files and the six `packages/platform-*`
 * manifest façades, which have no `facades/` directory at all).
 *
 * The `src/facades/` side reads TRACKED production sources (`listTrackedProductionSources`), the
 * same input every other layering scan uses, and is recursive so a nested façade cannot be
 * covered by one gate and missed by another. Tracked-only matters: an uncommitted scratch file
 * under a scanned path must stay invisible, or these gates start describing a contributor's
 * working directory instead of the committed tree (#1965 review).
 */
export function facadeEntryFiles(repoRoot: string): string[] {
  const tracked = new Set(listTrackedProductionSources(repoRoot));
  const found = new Set<string>();
  // Manifests are already tracked-only, but a tracked manifest's WORKING-TREE content can name a
  // target that is not committed yet, so the targets are intersected too. Both origins go through
  // the same tracked set: every path this returns is committed, whatever produced it.
  for (const pkg of readWorkspacePackages(repoRoot)) {
    for (const target of pkg.exportTargets.values()) {
      if (tracked.has(target)) found.add(target);
    }
  }
  for (const file of tracked) {
    if (file.includes('/src/facades/')) found.add(file);
  }
  return [...found].filter((file) => fs.existsSync(path.join(repoRoot, file))).sort();
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
export function checkPackageBoundaries(repoRoot: string): PackageBoundaryViolation[] {
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
      // (which is why this reads module records instead of scanning lines);
      // src/ and test/ suites stay covered — they import packages for real.
      if (root === 'scripts' && file.endsWith('.test.ts')) continue;
      const source = fs.readFileSync(path.join(repoRoot, file), 'utf8');
      violations.push(...checkRootSites(specifierSites(file, source), packages, rootDependencies));
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
