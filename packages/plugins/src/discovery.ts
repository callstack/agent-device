import fs from 'node:fs';
import path from 'node:path';
import { AppError } from '@agent-device/kernel/errors';
import { isRecord } from '@agent-device/kernel/record';
import { readPluginManifest, resolvePluginEntry, type PluginManifest } from './manifest.ts';

const PROVIDER_ID = /^[a-z][a-z0-9-]*$/;

export function isProviderId(value: unknown): value is string {
  return typeof value === 'string' && PROVIDER_ID.test(value);
}

/** The subpath a v2 plugin package exports; its default export is the plugin factory. */
const PLUGIN_ENTRY_SUBPATH = './agent-device';

export type PluginPackageEntry =
  | Readonly<{ kind: 'v2'; file: string }>
  | Readonly<{ kind: 'v1'; manifest: PluginManifest }>;

/**
 * Chooses how an installed package loads, without evaluating it. The `./agent-device` export wins;
 * a package that lacks that subpath and declares `agentDevicePlugin` is a v1 plugin dispatched by
 * its manifest; any other package falls back to its root export. A subpath that exists but does
 * not resolve is an error, never a reason to fall back.
 */
export function discoverPluginEntry(directory: string): PluginPackageEntry {
  const manifest = readPackageJson(directory);
  const subpath = resolveExport(manifest.exports, PLUGIN_ENTRY_SUBPATH);
  if (subpath.status === 'resolved') {
    return { kind: 'v2', file: resolvePluginEntry(directory, subpath.target) };
  }
  if (subpath.status === 'blocked') throw unresolvableEntry(directory, PLUGIN_ENTRY_SUBPATH);
  if (manifest.agentDevicePlugin !== undefined) {
    return { kind: 'v1', manifest: readPluginManifest(directory) };
  }
  const root = resolveExport(manifest.exports, '.');
  if (root.status === 'blocked') throw unresolvableEntry(directory, '.');
  const target =
    root.status === 'resolved'
      ? root.target
      : (manifest.exports === undefined || manifest.exports === null) &&
          typeof manifest.main === 'string'
        ? `./${path.posix.normalize(manifest.main)}`
        : undefined;
  if (target === undefined) throw missingEntry(directory, PLUGIN_ENTRY_SUBPATH);
  return { kind: 'v2', file: resolvePluginEntry(directory, target) };
}

export function readPackageJson(directory: string): Record<string, unknown> {
  try {
    const manifest = JSON.parse(fs.readFileSync(path.join(directory, 'package.json'), 'utf8'));
    if (isRecord(manifest)) return manifest;
  } catch (error) {
    throw new AppError(
      'INVALID_ARGS',
      `Cannot read plugin manifest: ${directory}`,
      { reason: 'plugin_load_failed' },
      error as Error,
    );
  }
  throw new AppError('INVALID_ARGS', `Cannot read plugin manifest: ${directory}`, {
    reason: 'plugin_load_failed',
  });
}

/**
 * `absent`: the package declares no key for the subpath. `blocked`: it declares one that Node's
 * resolver refuses, such as a condition set to `null` or no matching condition. Only `absent`
 * permits a fallback.
 */
type ExportResolution =
  | Readonly<{ status: 'resolved'; target: string }>
  | Readonly<{ status: 'absent' }>
  | Readonly<{ status: 'blocked' }>;

/** The condition set Node applies to an `import` of a package, in no particular order. */
const IMPORT_CONDITION_SET: ReadonlySet<string> = new Set([
  'node',
  'import',
  'module-sync',
  'node-addons',
  'default',
]);

/** Node's PACKAGE_EXPORTS_RESOLVE for `import`, including subpath patterns and `null` targets. */
function resolveExport(exportsField: unknown, subpath: string): ExportResolution {
  if (exportsField === undefined || exportsField === null) return { status: 'absent' };
  // Without subpath keys the field is the package root's target.
  if (!isSubpathMap(exportsField)) {
    return subpath === '.' ? settle(resolveTarget(exportsField, undefined)) : { status: 'absent' };
  }
  if (Object.hasOwn(exportsField, subpath) && !subpath.includes('*')) {
    return settle(resolveTarget(exportsField[subpath], undefined));
  }
  const match = bestPatternMatch(Object.keys(exportsField), subpath);
  return match
    ? settle(resolveTarget(exportsField[match.key], match.captured))
    : { status: 'absent' };
}

function settle(target: string | null | undefined): ExportResolution {
  return typeof target === 'string' ? { status: 'resolved', target } : { status: 'blocked' };
}

function isSubpathMap(value: unknown): value is Record<string, unknown> {
  return isRecord(value) && Object.keys(value).some((key) => key.startsWith('.'));
}

/** The pattern key (one `*`) with the longest prefix that matches, as Node's PATTERN_KEY_COMPARE orders them. */
function bestPatternMatch(
  keys: readonly string[],
  subpath: string,
): { key: string; captured: string } | undefined {
  let best: { key: string; base: string; trailer: string } | undefined;
  for (const key of keys) {
    const star = key.indexOf('*');
    if (star === -1 || star !== key.lastIndexOf('*')) continue;
    const base = key.slice(0, star);
    const trailer = key.slice(star + 1);
    const matches =
      subpath.startsWith(base) &&
      subpath !== base &&
      subpath.length >= key.length &&
      subpath.endsWith(trailer);
    if (!matches) continue;
    if (
      !best ||
      base.length > best.base.length ||
      (base.length === best.base.length && key.length > best.key.length)
    ) {
      best = { key, base, trailer };
    }
  }
  return best
    ? {
        key: best.key,
        captured: subpath.slice(best.base.length, subpath.length - best.trailer.length),
      }
    : undefined;
}

/** Node's PACKAGE_TARGET_RESOLVE: a string, `null` for a blocked target, or undefined for none. */
function resolveTarget(target: unknown, captured: string | undefined): string | null | undefined {
  if (typeof target === 'string') return resolveStringTarget(target, captured);
  if (target === null) return null;
  if (Array.isArray(target))
    return firstResolved(target.map((item) => () => resolveTarget(item, captured)));
  if (!isRecord(target)) return undefined;
  const matching = Object.entries(target).filter(([condition]) =>
    IMPORT_CONDITION_SET.has(condition),
  );
  return firstResolved(
    matching.map(
      ([, value]) =>
        () =>
          resolveTarget(value, captured),
    ),
  );
}

function resolveStringTarget(target: string, captured: string | undefined): string | undefined {
  if (!target.startsWith('./')) return undefined;
  return captured === undefined ? target : target.replaceAll('*', captured);
}

/** The first target that is not "none", which may be a `null` that blocks the rest. */
function firstResolved(
  candidates: readonly (() => string | null | undefined)[],
): string | null | undefined {
  for (const candidate of candidates) {
    const resolved = candidate();
    if (resolved !== undefined) return resolved;
  }
  return undefined;
}

function unresolvableEntry(directory: string, subpath: string): AppError {
  return new AppError('INVALID_ARGS', `Package exports ${subpath} without an import target`, {
    reason: 'incompatible_plugin',
    directory,
    hint: `Ask the plugin author for a release whose ${subpath} export has an import condition.`,
  });
}

function missingEntry(directory: string, subpath: string): AppError {
  return new AppError('INVALID_ARGS', 'Package does not export a provider plugin', {
    reason: 'incompatible_plugin',
    directory,
    hint: `Install a plugin release that exports ${subpath}.`,
  });
}
