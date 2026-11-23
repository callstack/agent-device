import { isRecord } from '@agent-device/kernel/record';

export type PluginSource = 'builtin' | 'store' | 'embedder';

export type PluginInventoryError = Readonly<{
  code: string;
  message: string;
  reason?: string;
  hint?: string;
}>;

/** The prerequisite a provider needs before it can register. */
export type PluginDormancy = Readonly<{
  reason: string;
  message: string;
  hint?: string;
}>;

export type PluginInventoryCredentials = Readonly<{
  variables: readonly string[];
  byBackend: Readonly<Record<string, readonly string[]>>;
}>;

type PluginInventoryIdentity = Readonly<{
  provider?: string;
  backend?: string;
  platform?: string;
  /** The leaf an `apple` platform claim narrows to: the macOS desktop mechanics. */
  appleOs?: 'macos';
  source: PluginSource;
  package?: string;
  version?: string;
  credentials: PluginInventoryCredentials;
}>;

/** One plugin as the daemon sees it: published in `daemon.json` and shown by `daemon status`. */
export type PluginInventoryEntry =
  | (PluginInventoryIdentity & Readonly<{ state: 'active'; error?: undefined }>)
  | (PluginInventoryIdentity &
      Readonly<{ provider: string; state: 'dormant'; dormant: PluginDormancy; error?: undefined }>)
  | (PluginInventoryIdentity & Readonly<{ state: 'failed'; error: PluginInventoryError }>);

/** One step of a plugin's cleanup: it completed, or it threw this typed error. */
export type PluginCleanupStep =
  | Readonly<{ status: 'ok' }>
  | Readonly<{ status: 'failed'; error: PluginInventoryError }>;

/**
 * What closing the registry did for one registered plugin. A plugin without `dispose` has nothing to
 * dispose, which reads as `ok`.
 */
export type PluginCleanupOutcome = Readonly<
  (
    | { provider: string; backend?: never; platform?: never }
    | { backend: string; provider?: never; platform?: never }
    | { platform: string; provider?: never; backend?: never }
  ) & {
    source: PluginSource;
    shutdown: PluginCleanupStep;
    dispose: PluginCleanupStep;
  }
>;

export const NO_PLUGIN_CREDENTIALS: PluginInventoryCredentials = Object.freeze({
  variables: Object.freeze([]),
  byBackend: Object.freeze({}),
});

/**
 * The credential variable names a lease on `leaseBackend` reads for `provider`: the backend's own
 * list when the plugin declares one, otherwise its flat list. Undefined when no active plugin
 * claims the provider.
 */
export function pluginCredentialVariables(
  inventory: readonly PluginInventoryEntry[],
  provider: string,
  leaseBackend?: string,
): readonly string[] | undefined {
  const entry = inventory.find((candidate) => candidate.provider === provider);
  if (entry?.state !== 'active') return undefined;
  const { variables, byBackend } = entry.credentials;
  return (
    (leaseBackend !== undefined && Object.hasOwn(byBackend, leaseBackend)
      ? byBackend[leaseBackend]
      : undefined) ?? variables
  );
}

/** Reads the inventory a daemon published, dropping anything that is not a well-formed entry. */
export function readPluginInventory(value: unknown): readonly PluginInventoryEntry[] {
  return Array.isArray(value) ? value.flatMap((entry) => readEntry(entry) ?? []) : [];
}

function readEntry(value: unknown): PluginInventoryEntry | undefined {
  if (!isRecord(value) || !isSource(value.source)) return undefined;
  const credentials = readCredentials(value.credentials);
  if (!credentials) return undefined;
  return readEntryState(value, {
    ...(typeof value.provider === 'string' ? { provider: value.provider } : {}),
    ...(typeof value.backend === 'string' ? { backend: value.backend } : {}),
    ...(typeof value.platform === 'string' ? { platform: value.platform } : {}),
    // A leaf is read only beside the family it narrows: macOS under `apple`.
    ...(value.platform === 'apple' && value.appleOs === 'macos'
      ? { appleOs: 'macos' as const }
      : {}),
    source: value.source,
    ...(typeof value.package === 'string' ? { package: value.package } : {}),
    ...(typeof value.version === 'string' ? { version: value.version } : {}),
    credentials,
  });
}

function readEntryState(
  value: Record<string, unknown>,
  identity: PluginInventoryIdentity,
): PluginInventoryEntry | undefined {
  if (value.state === 'active') return { ...identity, state: 'active' };
  if (value.state === 'dormant' && identity.provider !== undefined) {
    const dormant = readPluginDormancy(value.dormant);
    return dormant
      ? { ...identity, provider: identity.provider, state: 'dormant', dormant }
      : undefined;
  }
  const error = readError(value.error);
  return value.state === 'failed' && error ? { ...identity, state: 'failed', error } : undefined;
}

export function readPluginDormancy(value: unknown): PluginDormancy | undefined {
  if (!isRecord(value) || typeof value.reason !== 'string' || typeof value.message !== 'string') {
    return undefined;
  }
  const { reason, message, hint } = value;
  if (!reason.trim() || !message.trim() || (hint !== undefined && typeof hint !== 'string')) {
    return undefined;
  }
  return { reason, message, ...(hint === undefined ? {} : { hint }) };
}

function readCredentials(value: unknown): PluginInventoryCredentials | undefined {
  if (!isRecord(value)) return undefined;
  const variables = readNames(value.variables);
  const byBackend = value.byBackend === undefined ? {} : value.byBackend;
  if (!variables || !isRecord(byBackend)) return undefined;
  const entries = Object.entries(byBackend).map(([backend, names]) => [backend, readNames(names)]);
  if (entries.some(([, names]) => names === undefined)) return undefined;
  return {
    variables,
    byBackend: Object.fromEntries(entries) as Record<string, readonly string[]>,
  };
}

function isSource(value: unknown): value is PluginSource {
  return value === 'builtin' || value === 'store' || value === 'embedder';
}

function readNames(value: unknown): readonly string[] | undefined {
  return Array.isArray(value) && value.every((name) => typeof name === 'string')
    ? value
    : undefined;
}

function readError(value: unknown): PluginInventoryError | undefined {
  if (!isRecord(value) || typeof value.code !== 'string' || typeof value.message !== 'string') {
    return undefined;
  }
  return {
    code: value.code,
    message: value.message,
    ...(typeof value.reason === 'string' ? { reason: value.reason } : {}),
    ...(typeof value.hint === 'string' ? { hint: value.hint } : {}),
  };
}
