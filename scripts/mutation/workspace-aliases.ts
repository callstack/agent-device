import fs from 'node:fs';
import path from 'node:path';
import { workspaceSpecifierTargets } from '../layering/package-boundaries.ts';

export type WorkspaceSourceAlias = {
  find: RegExp;
  replacement: string;
};

export type ManifestSource = 'tracked-manifests' | 'disk-manifests';

function exactSpecifier(specifier: string): RegExp {
  return new RegExp(`^${specifier.replaceAll(/[.*+?^${}()|[\]\\]/g, String.raw`\$&`)}$`);
}

function specifierTargets(repoRoot: string, source: ManifestSource): ReadonlyMap<string, string> {
  return source === 'tracked-manifests'
    ? workspaceSpecifierTargets(repoRoot)
    : diskSpecifierTargets(repoRoot);
}

function diskSpecifierTargets(repoRoot: string): ReadonlyMap<string, string> {
  const targets = new Map<string, string>();
  const packagesDir = path.join(repoRoot, 'packages');
  if (!fs.existsSync(packagesDir)) return targets;
  for (const entry of fs.readdirSync(packagesDir)) {
    for (const [specifier, target] of manifestSpecifierTargets(packagesDir, entry)) {
      targets.set(specifier, target);
    }
  }
  return targets;
}

function* manifestSpecifierTargets(
  packagesDir: string,
  entry: string,
): Generator<[string, string]> {
  const manifestPath = path.join(packagesDir, entry, 'package.json');
  if (!fs.existsSync(manifestPath)) return;
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as {
    name?: string;
    exports?: Record<string, { default?: string }>;
  };
  if (!manifest.name?.startsWith('@agent-device/')) return;
  for (const [subpath, targetEntry] of Object.entries(manifest.exports ?? {})) {
    const target = targetEntry?.default;
    if (!target) continue;
    const specifier = subpath === '.' ? manifest.name : `${manifest.name}/${subpath.slice(2)}`;
    yield [specifier, path.join('packages', entry, target)];
  }
}

/** Exact exported workspace-package aliases for Vitest, from the declared manifest source. */
export function workspaceSourceAliases(
  repoRoot: string,
  source: ManifestSource,
): WorkspaceSourceAlias[] {
  return [...specifierTargets(repoRoot, source)].map(([specifier, target]) => ({
    find: exactSpecifier(specifier),
    replacement: path.join(repoRoot, target),
  }));
}
