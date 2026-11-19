import fs from 'node:fs';
import path from 'node:path';
import { AppError } from '@agent-device/kernel/errors';
import { isRecord } from '@agent-device/kernel/record';
import { NATIVE_REPLAY_BACKEND } from '@agent-device/contracts/replay-execution';
import { PLUGIN_API_VERSION, ROUTING_PROVIDER_IDENTITIES } from './contract.ts';

const PROVIDER_ID = /^[a-z][a-z0-9-]*$/;

export function isProviderId(value: unknown): value is string {
  return typeof value === 'string' && PROVIDER_ID.test(value);
}

/**
 * The static claims a plugin package declares in its `agent-device` package.json field, as claim
 * keys (`provider:<id>`, `replay-backend:<id>`, `replay-execution:ad`). Read before any import:
 * the apiVersion must be the supported one, and every declared claim must be unique and
 * unreserved. After the factory runs, its returned claim keys must equal these, in any order.
 */
export function readAgentDeviceClaims(manifest: Record<string, unknown>): readonly string[] {
  const field = manifest['agent-device'];
  if (!isRecord(field) || field.apiVersion !== PLUGIN_API_VERSION) {
    throw new AppError(
      'INVALID_ARGS',
      'Plugin package does not declare a compatible contract version',
      {
        reason: 'incompatible-plugin-api',
        apiVersion: PLUGIN_API_VERSION,
        ...(isRecord(field) && field.apiVersion !== undefined
          ? { declaredApiVersion: field.apiVersion }
          : {}),
        hint: `Install a plugin release supporting plugin contract apiVersion ${PLUGIN_API_VERSION}.`,
      },
    );
  }
  const claims: string[] = [];
  if (field.provider !== undefined) {
    if (!isProviderId(field.provider)) {
      throw new AppError('INVALID_ARGS', 'Plugin metadata provider must be a lowercase id', {
        reason: 'invalid_plugin',
      });
    }
    if (ROUTING_PROVIDER_IDENTITIES.includes(field.provider)) {
      throw new AppError('INVALID_ARGS', `Provider id is reserved for routing: ${field.provider}`, {
        reason: 'reserved_provider',
        provider: field.provider,
      });
    }
    claims.push(`provider:${field.provider}`);
  }
  if (field.replayBackend !== undefined) {
    if (!isProviderId(field.replayBackend)) {
      throw new AppError('INVALID_ARGS', 'Plugin metadata replayBackend must be a lowercase id', {
        reason: 'invalid_plugin',
      });
    }
    if (field.replayBackend === NATIVE_REPLAY_BACKEND) {
      throw new AppError(
        'INVALID_ARGS',
        `Replay backend id is reserved for native execution: ${NATIVE_REPLAY_BACKEND}`,
        { reason: 'reserved_replay_backend', backend: NATIVE_REPLAY_BACKEND },
      );
    }
    claims.push(`replay-backend:${field.replayBackend}`);
  }
  if (field.replayExecution !== undefined) {
    if (field.replayExecution !== true && field.replayExecution !== NATIVE_REPLAY_BACKEND) {
      throw new AppError(
        'INVALID_ARGS',
        `Plugin metadata replayExecution must be true or "${NATIVE_REPLAY_BACKEND}"`,
        { reason: 'invalid_plugin' },
      );
    }
    claims.push(`replay-execution:${NATIVE_REPLAY_BACKEND}`);
  }
  return claims;
}

/**
 * The Node floor a package's `engines.node` range establishes, checked before import. Only the
 * lower bound matters: upper bounds and unparseable comparators impose no floor.
 */
export function assertNodeFloor(manifest: Record<string, unknown>): void {
  const engines = manifest.engines;
  if (!isRecord(engines) || typeof engines.node !== 'string') return;
  const floor = nodeRangeFloor(engines.node);
  if (floor === undefined) return;
  const node = process.versions.node;
  if (compareVersions(node, floor) < 0) {
    throw new AppError(
      'INVALID_ARGS',
      `Plugin requires Node ${engines.node}; this host runs Node ${node}`,
      { reason: 'node-below-floor', engines: engines.node, node },
    );
  }
}

type Version = readonly [number, number, number];

/** The lowest version a semver range can admit, as `nodeRangeFloor` computes it. */
export function nodeRangeFloor(range: string): string | undefined {
  let lowest: Version | undefined;
  for (const branch of range.split('||')) {
    let branchFloor: Version | undefined;
    for (const comparator of branch.trim().split(/\s+/)) {
      const parsed = parseComparator(comparator);
      if (parsed === undefined) continue;
      if (branchFloor === undefined || compareVersionsTuple(parsed, branchFloor) > 0) {
        branchFloor = parsed;
      }
    }
    if (
      branchFloor !== undefined &&
      (lowest === undefined || compareVersionsTuple(branchFloor, lowest) < 0)
    ) {
      lowest = branchFloor;
    }
  }
  return lowest === undefined ? undefined : lowest.join('.');
}

/** The floor one comparator admits: lower bounds and exact/caret/tilde versions, never upper bounds. */
function parseComparator(comparator: string): Version | undefined {
  const match = /^(>=|>|<=|<|=|\^|~)?(.+)$/.exec(comparator);
  if (!match) return undefined;
  const op = match[1] ?? '';
  if (op === '<' || op === '<=') return undefined;
  return parseVersion(match[2] ?? '');
}

function parseVersion(text: string): Version | undefined {
  const match = /^v?(\d+)(?:\.(\d+))?(?:\.(\d+))?/.exec(text.trim());
  if (!match) return undefined;
  return [Number(match[1]), Number(match[2] ?? 0), Number(match[3] ?? 0)];
}

function compareVersionsTuple(a: Version, b: Version): number {
  for (let index = 0; index < 3; index++) {
    const diff = a[index]! - b[index]!;
    if (diff !== 0) return diff;
  }
  return 0;
}

function compareVersions(a: string, b: string): number {
  const pa = parseVersion(a);
  const pb = parseVersion(b);
  if (pa === undefined || pb === undefined) return 0;
  const byCore = compareVersionsTuple(pa, pb);
  if (byCore !== 0) return byCore;
  // A prerelease sorts below the same release.
  const aPre = a.includes('-');
  const bPre = b.includes('-');
  return aPre === bPre ? 0 : aPre ? -1 : 1;
}

/** The subpath a plugin package exports; its default export is the plugin factory. */
const PLUGIN_ENTRY_SUBPATH = './agent-device';

/**
 * Chooses the file an installed package loads, without evaluating it. The `./agent-device` export
 * wins; a package that lacks that subpath falls back to its root export. A subpath that exists but
 * does not resolve is an error, never a reason to fall back.
 */
export function discoverPluginEntry(directory: string): string {
  const manifest = readPackageJson(directory);
  const subpath = resolveExport(manifest.exports, PLUGIN_ENTRY_SUBPATH);
  if (subpath.status === 'resolved') return resolvePluginEntry(directory, subpath.target);
  if (subpath.status === 'blocked') throw unresolvableEntry(directory, PLUGIN_ENTRY_SUBPATH);
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
  return resolvePluginEntry(directory, target);
}

/**
 * The entry a plugin package names: a readable file inside the package directory it is installed
 * in. Traversal and a symlink out of that directory are refused.
 */
function resolvePluginEntry(directory: string, target: string): string {
  try {
    const root = fs.realpathSync(directory);
    const resolved = fs.realpathSync(path.resolve(directory, target));
    if (
      target.startsWith('./') &&
      resolved.startsWith(`${root}${path.sep}`) &&
      fs.statSync(resolved).isFile()
    ) {
      return resolved;
    }
  } catch {}
  throw new AppError('INVALID_ARGS', 'Plugin entry must be a readable file inside its package', {
    reason: 'plugin_load_failed',
    directory,
    entry: target,
  });
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
