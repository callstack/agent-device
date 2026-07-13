import { AppError } from '../kernel/errors.ts';
import type { SessionAction } from '../daemon/types.ts';

export type ReplayVarScope = {
  values: Readonly<Record<string, string>>;
  /** Built-ins resolved into an action, tracked for divergence redaction. */
  expandedBuiltinNames?: Set<string>;
};

export type ReplayVarSources = {
  builtins?: Record<string, string>;
  fileEnv?: Record<string, string>;
  shellEnv?: Record<string, string>;
  cliEnv?: Record<string, string>;
};

export const REPLAY_VAR_KEY_RE = /^[A-Z_][A-Z0-9_]*$/;
const INTERPOLATION_RE = /(\\\$\{)|\$\{([A-Za-z_][A-Za-z0-9_.]*)(?::-((?:[^}\\]|\\.)*))?\}/g;
const SHELL_PREFIX = 'AD_VAR_';
const RESERVED_NAMESPACE_PREFIX = 'AD_';

function isReservedNamespaceKey(key: string): boolean {
  return key.startsWith(RESERVED_NAMESPACE_PREFIX);
}

function reservedNamespaceError(key: string): AppError {
  return new AppError(
    'INVALID_ARGS',
    `The AD_* namespace is reserved for built-in variables. Rename ${key} to avoid the AD_ prefix.`,
  );
}

export function buildReplayVarScope(sources: ReplayVarSources): ReplayVarScope {
  const merged: Record<string, string> = {};
  // builtins are trusted (set by the runtime) and may legitimately use AD_*.
  if (sources.builtins) {
    for (const [key, value] of Object.entries(sources.builtins)) {
      merged[key] = value;
    }
  }
  const untrustedLayers: Array<Record<string, string> | undefined> = [
    sources.fileEnv,
    sources.shellEnv,
    sources.cliEnv,
  ];
  for (const layer of untrustedLayers) {
    if (!layer) continue;
    for (const [key, value] of Object.entries(layer)) {
      if (isReservedNamespaceKey(key)) {
        throw reservedNamespaceError(key);
      }
      merged[key] = value;
    }
  }
  return { values: merged, expandedBuiltinNames: new Set() };
}

export function collectReplayShellEnv(processEnv: NodeJS.ProcessEnv): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [rawKey, value] of Object.entries(processEnv)) {
    if (typeof value !== 'string') continue;
    if (!rawKey.startsWith(SHELL_PREFIX)) continue;
    const key = rawKey.slice(SHELL_PREFIX.length);
    if (key.length === 0) continue;
    if (!REPLAY_VAR_KEY_RE.test(key)) continue;
    // Belt-and-suspenders: never let the stripped key land back in the reserved
    // AD_* namespace (e.g. shell `AD_VAR_AD_SESSION=evil` would become `AD_SESSION`).
    if (isReservedNamespaceKey(key)) continue;
    result[key] = value;
  }
  return result;
}

export function parseReplayCliEnvEntries(entries: readonly string[]): Record<string, string> {
  const result: Record<string, string> = {};
  for (const entry of entries) {
    const eqIndex = entry.indexOf('=');
    if (eqIndex <= 0) {
      throw new AppError('INVALID_ARGS', `Invalid -e entry "${entry}": expected KEY=VALUE.`);
    }
    const key = entry.slice(0, eqIndex);
    if (!REPLAY_VAR_KEY_RE.test(key)) {
      throw new AppError(
        'INVALID_ARGS',
        `Invalid -e key "${key}": keys must be uppercase letters, digits, and underscores (e.g. APP_ID).`,
      );
    }
    if (isReservedNamespaceKey(key)) {
      throw reservedNamespaceError(key);
    }
    result[key] = entry.slice(eqIndex + 1);
  }
  return result;
}

export function readReplayCliEnvEntries(raw: unknown): string[] {
  return Array.isArray(raw)
    ? raw.filter((value): value is string => typeof value === 'string')
    : [];
}

export function readReplayShellEnvSource(raw: unknown): NodeJS.ProcessEnv {
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
    const result: NodeJS.ProcessEnv = {};
    for (const [key, value] of Object.entries(raw)) {
      if (typeof value === 'string') result[key] = value;
    }
    return result;
  }
  return process.env;
}

export function resolveReplayString(
  raw: string,
  scope: ReplayVarScope,
  loc: { file: string; line: number },
): string {
  return raw.replace(
    INTERPOLATION_RE,
    (
      match,
      escapedLiteral: string | undefined,
      key: string | undefined,
      fallback: string | undefined,
    ) => {
      if (escapedLiteral) return '${';
      if (!key) return match;
      if (Object.prototype.hasOwnProperty.call(scope.values, key)) {
        if (isReservedNamespaceKey(key)) {
          (scope.expandedBuiltinNames ??= new Set()).add(key);
        }
        return String(scope.values[key]);
      }
      if (fallback !== undefined) {
        return fallback.replace(/\\(.)/g, '$1');
      }
      throw new AppError(
        'INVALID_ARGS',
        `Unresolved variable \${${key}} at ${loc.file}:${loc.line}.`,
      );
    },
  );
}

export function resolveReplayAction(
  action: SessionAction,
  scope: ReplayVarScope,
  loc: { file: string; line: number },
): SessionAction {
  return {
    ...action,
    positionals: (action.positionals ?? []).map((token) => resolveReplayString(token, scope, loc)),
    flags: resolveStringProps(action.flags, scope, loc) ?? {},
    runtime: resolveStringProps(action.runtime, scope, loc),
  };
}

function resolveStringProps<T extends object>(
  obj: T | undefined,
  scope: ReplayVarScope,
  loc: { file: string; line: number },
): T | undefined {
  if (!obj) return obj;
  return resolveStringValue(obj, scope, loc) as T;
}

function resolveStringValue(
  value: unknown,
  scope: ReplayVarScope,
  loc: { file: string; line: number },
): unknown {
  if (typeof value === 'string') return resolveReplayString(value, scope, loc);
  if (Array.isArray(value)) return value.map((entry) => resolveStringValue(entry, scope, loc));
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [key, resolveStringValue(entry, scope, loc)]),
    );
  }
  return value;
}

/**
 * Values of every non-builtin scope variable, plus built-ins that were
 * expanded into a replay action. ADR 0012 forbids serializing expanded
 * variables into a divergence report. Tracking built-in expansion avoids
 * redacting ordinary static text that merely matches an unused runtime label.
 * Longest values first so overlapping values scrub deterministically.
 */
export function collectReplayScrubbableVarValues(
  scope: ReplayVarScope,
): Array<{ name: string; value: string }> {
  return Object.entries(scope.values)
    .filter(
      ([key, value]) =>
        value.length > 0 && (!isReservedNamespaceKey(key) || scope.expandedBuiltinNames?.has(key)),
    )
    .map(([name, value]) => ({ name, value }))
    .sort((a, b) => b.value.length - a.value.length);
}
