// Catches: a package importing a workspace sibling its manifest never declared, and a root
//   file tunnelling into a package's src with a relative path — both for every file, compiled
//   or not — plus the whole specifier sweep (unknown package, un-exported subpath) for the
//   scripts/ files the type graph omits. `tsc -b` owns the rest of the old R11 surface for
//   compiled sources: NodeNext resolution rejects a non-exported subpath and an unknown
//   package (TS2307), and composite `rootDir` rejects a package→root relative escape
//   (TS6059 + TS6307) — planted proofs recorded on #3279.
// Evidence: 76453add71 (#1494, #1490 W0) established the workspace split this rule protects;
//   83322a3f2f (#1574) pinned exact facade symbols for every workspace package; #3279 moved the
//   type-check onto `tsc -b` project references and retired the checks it now enforces.
// Cost: 447 LOC (rule) + 978 LOC (test).
// Kill criterion: retire a remaining branch only when something owns its mechanism, not merely
//   its symptom. An undeclared `workspace:*` sibling is type-clean and runtime-green INSIDE
//   this repo because pnpm links every workspace package under the root `node_modules` — the
//   declaration is what the published bundle externalizes against, so no compiler check can
//   express it here (planted in #3279: `tsc -b` accepted it). A relative root→package tunnel
//   typechecks too; its failure is the runtime double instantiation this rule names.
//
// R11 package-boundaries: the workspace rules of #1490, as data the gate walks.
//
// What remains is exactly what the type graph cannot see:
// a package import of a sibling the manifest never declared (pnpm's root links make it resolve
// anyway), a root file tunnelling into `packages/*/src` with a relative path (tsc typechecks
// it fine; Node's ESM loader does not realpath specifiers, so a module loaded BOTH relatively
// and via its package specifier instantiates twice in one process — duplicate AppError, broken
// instanceof), and, for `scripts/` files which sit outside the type graph by design, the
// root-side unknown-package and exports-map checks that compiled files get from TS2307.

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
  /** Where siblings are declared: a published package bundles them, so it lists them as dev-only. */
  workspaceDependencyField: 'dependencies' | 'devDependencies';
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
  return workspacePackagesFromManifests(
    new Map(
      listTrackedPackageManifests(repoRoot).map((manifestFile) => [
        manifestFile,
        fs.readFileSync(path.join(repoRoot, manifestFile), 'utf8'),
      ]),
    ),
  );
}

/** The same package model over manifest sources already in hand, e.g. read from a git ref. */
export function workspacePackagesFromManifests(
  manifests: ReadonlyMap<string, string>,
): WorkspacePackage[] {
  const packages: WorkspacePackage[] = [];
  for (const manifestFile of [...manifests.keys()].sort()) {
    const entry = path.posix.basename(path.posix.dirname(manifestFile));
    const manifest = JSON.parse(manifests.get(manifestFile)!) as {
      name?: string;
      private?: boolean;
      exports?: Record<string, { default?: string; import?: string } | string>;
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };
    if (!manifest.name) continue;
    const exportTargets = new Map<string, string>();
    for (const [subpath, target] of Object.entries(manifest.exports ?? {})) {
      const targetFile = typeof target === 'string' ? target : (target.default ?? target.import);
      if (!targetFile) continue;
      exportTargets.set(
        path.posix.join(manifest.name, subpath),
        path.posix.join('packages', entry, path.posix.normalize(targetFile)),
      );
    }
    const workspaceDependencyField = manifest.private === true ? 'dependencies' : 'devDependencies';
    const workspaceDependencies = new Set(
      Object.entries(manifest[workspaceDependencyField] ?? {})
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
      workspaceDependencyField,
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
 * The file set R11 treats as parsed by the `tsc -b` graph: each package project includes its
 * own `src/`, and the root project includes `src/` and `test/`. Everything else the R11 walk
 * visits — the rest of `scripts/` (gate and tooling modules run through
 * `--experimental-strip-types`, not a tsconfig program), the `packages/maestro/test/`
 * conformance harness, and package build configs — reaches packages through import sites the
 * compiler never parses, so R11 stays the only owner of every boundary claim about those
 * routes (#3279). Only the RESOLUTION branches (unknown package, un-exported subpath) are
 * split this way; the relative-escape branch fires regardless — a planted sibling tunnel
 * `tsc -b` accepted, see `checkPackageInternalSites`.
 *
 * One documented divergence: the root program also includes
 * `scripts/help-conformance-command-validator.ts`, which this predicate classifies as
 * uncompiled. That is fail-closed — R11 keeps its full branch set (unknown package,
 * exports-map) for the file on top of what tsc enforces — never fail-open. The divergence
 * and the exact root include list are pinned in `project-references.test.ts`, and the
 * per-package `include: ["src"]` / no-`exclude` shape this predicate's regexes assume is
 * pinned there too, so widening any project's file set must be recorded there rather than
 * silently diverging from this predicate.
 */
export function insideCompiledSources(file: string): boolean {
  return /^packages\/[^/]+\/src\//.test(file) || /^src\//.test(file) || /^test\//.test(file);
}

/**
 * Rules for files INSIDE a package. An undeclared sibling import is R11's alone: pnpm links
 * every workspace package under the root `node_modules`, so the import resolves, compiles, and
 * runs in this repo even when the manifest never declares it — and a published bundle
 * externalizes against that declaration. The relative escape past the package dir is R11's
 * too, compiled or not: a planted `pnpm exec tsc -b packages/host-kit --force` with
 * `import { AppError } from '../../kernel/src/errors.ts'` in `host-kit/src/` **exits 0** —
 * the redirect to kernel's `dist-types` keeps every emitted file under host-kit's `rootDir`,
 * so neither TS6059 nor TS6307 fires (the root-escape tunnel DOES fail: TS2307, since `../..
 * /../kernel/...` lands outside every include and no package owns `kernel` at that depth).
 * What the sibling tunnel risks is runtime identity: Node's ESM loader does not realpath
 * specifiers, so when the same module is ALSO loaded through its package specifier — the
 * normal route for every other consumer — the two keys instantiate it twice in one process
 * (duplicate AppError, broken `instanceof`). Type-only tunnels carry no runtime cost, but
 * the branch cannot condition on that from syntax alone and the layering claim fails either
 * way. Any duplicate-instance risk invisible to the compiler is R11's to hold; the
 * remaining resolution failures (unknown package, subpath the exports map does not name)
 * are owned by NodeNext for compiled files with TS2307; uncompiled files never reach either
 * check, so for them R11 holds every branch.
 */
export function checkPackageInternalSites(
  pkg: WorkspacePackage,
  sites: readonly SpecifierSite[],
  allPackages: readonly WorkspacePackage[],
  compiled: boolean,
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
            `'${site.specifier}' escapes ${pkg.dir}/ — a workspace package may not reach ` +
            `outside its own directory. Import a sibling through its specifier (mixing the ` +
            `two routes instantiates the module twice), or move the shared code below ` +
            `${pkg.dir}.`,
        });
      }
      continue;
    }
    const name = specifierPackageName(site.specifier);
    if (!name || !name.startsWith('@agent-device/')) continue;
    const target = packageByName(allPackages, name);
    if (!target) {
      if (!compiled) {
        violations.push({
          rule: 'R11 package-boundaries',
          file: site.file,
          line: site.line,
          message: `'${site.specifier}' names an unknown workspace package.`,
        });
      }
      continue;
    }
    if (name !== pkg.name && !pkg.workspaceDependencies.has(name)) {
      violations.push({
        rule: 'R11 package-boundaries',
        file: site.file,
        line: site.line,
        message:
          `${pkg.name} imports '${site.specifier}' without declaring "${name}": "workspace:*" ` +
          `in ${pkg.dir}/package.json ${pkg.workspaceDependencyField}.`,
      });
    }
    if (!compiled && !target.exportTargets.has(site.specifier)) {
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
 * Rules for files OUTSIDE packages/ (src, test, scripts). Two claims remain R11's own for every
 * root file: the relative tunnel into a packages/<name>/src directory — the compiler typechecks
 * such an import
 * fine (#3279), but Node's ESM loader does not realpath specifiers, so dual relative/specifier
 * loads instantiate the module twice — and a workspace specifier the root manifest never
 * declares, which the root's own link farm resolves anyway. For compiled root files the
 * compiler owns unknown packages and un-exported subpaths with TS2307; for scripts/ files,
 * which sit outside the type graph by design, R11 keeps every branch.
 */
export function checkRootSites(
  sites: readonly SpecifierSite[],
  packages: readonly WorkspacePackage[],
  rootWorkspaceDependencies: ReadonlySet<string>,
  compiled: boolean,
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
      if (!compiled) {
        violations.push({
          rule: 'R11 package-boundaries',
          file: site.file,
          line: site.line,
          message: `'${site.specifier}' names an unknown workspace package.`,
        });
      }
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
    if (!compiled && !target.exportTargets.has(site.specifier)) {
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
  return specifierTargetsOf(readWorkspacePackages(repoRoot));
}

/** The same flat map for a manifest set read elsewhere, e.g. at a git ref. */
export function workspaceSpecifierTargetsFromManifests(
  manifests: ReadonlyMap<string, string>,
): Map<string, string> {
  return specifierTargetsOf(workspacePackagesFromManifests(manifests));
}

function specifierTargetsOf(packages: readonly WorkspacePackage[]): Map<string, string> {
  const targets = new Map<string, string>();
  for (const pkg of packages) {
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
      violations.push(
        ...checkPackageInternalSites(
          pkg,
          specifierSites(file, source),
          packages,
          insideCompiledSources(file),
        ),
      );
    }
  }
  for (const root of ['src', 'test', 'scripts']) {
    for (const file of walkTsFiles(repoRoot, root)) {
      // Gate tests under scripts/ carry import syntax inside fixture strings
      // (which is why this reads module records instead of scanning lines);
      // src/ and test/ suites stay covered — they import packages for real.
      if (root === 'scripts' && file.endsWith('.test.ts')) continue;
      const source = fs.readFileSync(path.join(repoRoot, file), 'utf8');
      violations.push(
        ...checkRootSites(
          specifierSites(file, source),
          packages,
          rootDependencies,
          insideCompiledSources(file),
        ),
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
    `with zero undeclared or relative-tunnel import routes (the compiler owns specifier ` +
    `resolution for compiled sources)`
  );
}
