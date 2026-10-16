// Catches: an isolated workspace package acquiring a dependency on the code it must stay below —
//   as a manifest entry (directly, or through any chain of workspace packages), as an import
//   (static, type-only, dynamic or `vi.mock` literal), or by reaching out of its directory — and a
//   package it reaches declaring it back, which TypeScript project references reject as a cycle.
//   `@agent-device/test-kit` may not build on platform, provider, daemon or root code; the plugin
//   framework `@agent-device/plugins` may not build on a concrete provider package.
// Evidence: the single-entry test-kit loads every helper eagerly, so one platform import would put
//   that platform's closure into every test's import graph; #3712 extracted the plugin loader with
//   `provider-webdriver` still imported by its manifest and loader, and a chain through another
//   workspace package would have reached the same provider unseen by a direct-dependency check.
// Cost: one pass over the tracked manifests and the isolated packages' sources.
// Kill criterion: a maintainer decision that an isolated package may depend on the code its policy
//   forbids, or that provider-* packages stop being the unit of provider implementation.
//
// The forbidden set is derived from the workspace layout, not from name patterns: every package
// whose directory matches the policy, whatever name it publishes (e.g. `@agent-device/testmu` under
// `packages/provider-testmu`). A new isolated package is one more `PackageIsolationPolicy`
// declaration passed to the check.

import path from 'node:path';
import type { LayeringViolation } from './model.ts';
import { specifierSites } from './package-boundaries.ts';
import { PACKAGE_EXPORT_SURFACE_RULE, TEST_KIT_PACKAGE } from './package-export-surface.ts';

export const PLUGIN_FRAMEWORK_INDEPENDENCE_RULE = 'R85 plugin-framework-independence';

export type PackageIsolationPolicy = {
  rule: string;
  /** Repo-relative package directory, e.g. `packages/test-kit`. */
  dir: string;
  /** The name the package publishes. */
  name: string;
  /** Manifest paths of the workspace packages this package may not reach. */
  forbiddenManifests: RegExp;
  /** The root `agent-device` package is forbidden too. */
  forbidsRoot: boolean;
  /** What is forbidden and where that code's knowledge belongs, for diagnostics. */
  forbids: string;
  remedy: string;
};

export const TEST_KIT_ISOLATION: PackageIsolationPolicy = {
  rule: PACKAGE_EXPORT_SURFACE_RULE,
  dir: 'packages/test-kit',
  name: TEST_KIT_PACKAGE,
  forbiddenManifests: /^packages\/(?:platform-[^/]+|provider-[^/]+|daemon)\/package\.json$/,
  forbidsRoot: true,
  forbids: 'a platform, provider, daemon or root package',
  remedy: 'A fixture that needs that code is a test of that package and belongs in it.',
};

export const PLUGIN_FRAMEWORK_ISOLATION: PackageIsolationPolicy = {
  rule: PLUGIN_FRAMEWORK_INDEPENDENCE_RULE,
  dir: 'packages/plugins',
  name: '@agent-device/plugins',
  forbiddenManifests: /^packages\/provider-[^/]+\/package\.json$/,
  forbidsRoot: false,
  forbids: 'a concrete provider package',
  remedy: 'Provider knowledge reaches the loader as a policy from the composing root.',
};

export type DependencyManifest = {
  name?: string;
  exports?: unknown;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
};

export type ParsedManifests = ReadonlyMap<string, DependencyManifest>;

export function parseManifests(manifests: ReadonlyMap<string, string>): ParsedManifests {
  return new Map(
    [...manifests].map(([file, text]) => [file, JSON.parse(text) as DependencyManifest]),
  );
}

/** Every package name a manifest declares in any dependency field. */
function declaredNames(manifest: DependencyManifest): string[] {
  return [
    ...Object.keys(manifest.dependencies ?? {}),
    ...Object.keys(manifest.devDependencies ?? {}),
    ...Object.keys(manifest.optionalDependencies ?? {}),
    ...Object.keys(manifest.peerDependencies ?? {}),
  ];
}

const ROOT_PACKAGE = 'agent-device';

function forbiddenNames(parsed: ParsedManifests, policy: PackageIsolationPolicy): Set<string> {
  const names = new Set(policy.forbidsRoot ? [ROOT_PACKAGE] : []);
  for (const [file, manifest] of parsed) {
    if (policy.forbiddenManifests.test(file) && manifest.name) names.add(manifest.name);
  }
  return names;
}

function packageName(specifier: string): string {
  const parts = specifier.split('/');
  return specifier.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0]!;
}

/**
 * Manifest reach from the policy's package, breadth-first over every dependency field of the
 * workspace graph. A forbidden package ends a branch with the chain that reached it; a package
 * that declares the policy's package back closes a project-reference cycle.
 */
function manifestViolations(
  parsed: ParsedManifests,
  policy: PackageIsolationPolicy,
  forbidden: ReadonlySet<string>,
): LayeringViolation[] {
  const violations: LayeringViolation[] = [];
  const manifestFile = `${policy.dir}/package.json`;
  const fileByName = new Map<string, string>();
  for (const [file, manifest] of parsed) if (manifest.name) fileByName.set(manifest.name, file);

  const via = new Map<string, string[]>([[policy.name, [policy.name]]]);
  const queue = [policy.name];
  while (queue.length > 0) {
    const current = queue.shift()!;
    const manifest = parsed.get(fileByName.get(current) ?? '');
    if (!manifest) continue;
    for (const name of declaredNames(manifest)) {
      const chain = [...via.get(current)!, name];
      if (name === policy.name && current !== policy.name) {
        violations.push({
          rule: policy.rule,
          file: fileByName.get(current)!,
          line: 1,
          message:
            `${chain.join(' -> ')} closes a project-reference cycle: '${current}' is reached ` +
            `from ${policy.name} and cannot declare it back.`,
        });
        continue;
      }
      if (forbidden.has(name)) {
        violations.push({
          rule: policy.rule,
          file: manifestFile,
          line: 1,
          message: `${chain.join(' -> ')}: ${policy.name} builds on ${policy.forbids}. ${policy.remedy}`,
        });
        continue;
      }
      if (!fileByName.has(name) || via.has(name)) continue;
      via.set(name, chain);
      queue.push(name);
    }
  }
  return violations;
}

/**
 * One isolated package's boundary: no forbidden package reached through the manifest graph (so a
 * chain through host-kit or contracts counts), no import of one or relative reach out of its
 * directory (the shared import walk, so `vi.mock` literals count), and no package it reaches
 * declaring it back.
 */
export function checkPackageIsolation(
  parsed: ParsedManifests,
  sources: ReadonlyMap<string, string>,
  policy: PackageIsolationPolicy,
): LayeringViolation[] {
  if (!parsed.has(`${policy.dir}/package.json`)) return [];
  const forbidden = forbiddenNames(parsed, policy);
  const violations = manifestViolations(parsed, policy, forbidden);

  for (const [file, source] of sources) {
    if (!file.startsWith(`${policy.dir}/`)) continue;
    for (const site of specifierSites(file, source)) {
      const escapes =
        site.specifier.startsWith('.') &&
        !path.posix.join(path.posix.dirname(file), site.specifier).startsWith(`${policy.dir}/`);
      if (!escapes && !forbidden.has(packageName(site.specifier))) continue;
      violations.push({
        rule: policy.rule,
        file,
        line: site.line,
        message:
          `${policy.name} imports '${site.specifier}'. It may not build on ${policy.forbids} ` +
          `or reach out of ${policy.dir}/. ${policy.remedy}`,
      });
    }
  }
  return violations;
}
