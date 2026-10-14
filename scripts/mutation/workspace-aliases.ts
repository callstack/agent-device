import fs from 'node:fs';
import path from 'node:path';
import { workspaceSpecifierTargets } from '../layering/package-boundaries.ts';

export type WorkspaceSourceAlias = {
  find: RegExp;
  replacement: string;
};

export type ManifestSource = 'tracked-manifests' | 'disk-manifests';

function escapeRegExp(literal: string): string {
  return literal.replaceAll(/[.*+?^${}()|[\]\\]/g, String.raw`\$&`);
}

function exactSpecifier(specifier: string): RegExp {
  return new RegExp(`^${escapeRegExp(specifier)}$`);
}

/**
 * An alias pair for one exports entry: exact for a named subpath, and a capture-
 * group pattern for a `*` pattern entry (ADR-0033's `./testing/<dir>/*`). Emitting
 * the pattern key as a literal matches nothing, so every concrete import of a
 * pattern-exported module would load the UNaliased path in the Stryker sandbox —
 * a different module id than its `vi.mock` registers, and the mock silently misses
 * (#3546 review). Vite substitutes `$1` into the target template the way Node
 * fills the exports target's `*`.
 */
function aliasFor(specifier: string, target: string, repoRoot: string): WorkspaceSourceAlias {
  if (specifier.endsWith('*') && target.includes('*')) {
    // Node requires exactly one `*` in the target, so it splices at a known
    // index; `$` in the repo path is escaped so Vite sees only the `$1` fill.
    const template = path.join(repoRoot, target);
    const star = template.indexOf('*');
    // The callback form is load-bearing: in a string replacement `$$` IS one
    // literal `$`, so a string '$$' would replace each `$` with itself and
    // leave `$1`/`$&` in the repo path to be expanded when the alias applies.
    const escapeDollar = (text: string) => text.replaceAll('$', () => '$$');
    return {
      find: new RegExp(`^${escapeRegExp(specifier.slice(0, -1))}(.*)$`),
      replacement:
        escapeDollar(template.slice(0, star)) + '$1' + escapeDollar(template.slice(star + 1)),
    };
  }
  return { find: exactSpecifier(specifier), replacement: path.join(repoRoot, target) };
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

/**
 * Exported workspace-package aliases for Vitest, from the declared manifest source:
 * one per exports entry, exact for named subpaths and capture-group patterns for
 * `*` entries. Vite applies aliases in list order, so exact entries are emitted
 * first — a named subpath under a pattern's prefix keeps its own export.
 */
export function workspaceSourceAliases(
  repoRoot: string,
  source: ManifestSource,
): WorkspaceSourceAlias[] {
  const targets = [...specifierTargets(repoRoot, source)];
  const patterns = targets.filter(([specifier]) => specifier.endsWith('*'));
  // Vite applies the first matching alias, so exact entries lead (Node's exact
  // precedence) and patterns follow sorted by prefix length descending (Node's
  // longest-prefix rule) — the same order resolveWorkspaceSpecifier resolves in,
  // so the sandbox never picks a different module id than the exports semantics.
  patterns.sort(([a], [b]) => b.length - a.length);
  return [...targets.filter(([specifier]) => !specifier.endsWith('*')), ...patterns].map(
    ([specifier, target]) => aliasFor(specifier, target, repoRoot),
  );
}
