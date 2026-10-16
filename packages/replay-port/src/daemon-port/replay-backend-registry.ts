import type { ReplayBackendId } from '@agent-device/ad-script';
import type { ReplayBackend, ReplayBackendPlugin } from '@agent-device/contracts/replay-backend';

/**
 * The replay backend registry (#3377).
 *
 * The host (the replay command, `test` discovery, request device binding, and the client-side
 * replay surface) reaches a non-native engine only through this module. A backend id resolves to
 * one plugin (`ReplayBackendPlugin`, `create(host)`) whose loading is memoized per process; this
 * module and `replay-backend-declarations.ts` are the only host code that names an engine package. Backend ids come from the format grammar's vocabulary
 * (`@agent-device/ad-script`), so the registry's keys and the `--maestro` flag's accepted values
 * can never drift apart. The Maestro plugin extraction (#3377) swaps the builtin
 * table for an installed-plugin lookup and changes no caller.
 *
 * A backend is a capability bundle over scripts: it expands a source closure, inspects a flow for
 * scheduling metadata, runs a replay, and converts a native `.ad` script into its own format.
 * Dispatch, session, and wire policy stay on this side — a backend receives an already-prepared
 * command and returns an ordinary `DaemonResponse`, so the daemon never re-enters engine parsing
 * or compatibility dispatch (ADR 0015).
 *
 * A hub eager-closure rule of this repository (`scripts/__tests__/eager-closure-budgets.ts`)
 * holds `src/cli.ts` and `src/daemon.ts` to "no new module evaluated at startup", so the host's
 * value imports of this module are function-scoped `await import()` calls at the few call sites;
 * the plugin, its declaration, and the host behind it are reached the same way. Type imports are
 * free.
 */

/**
 * Builtin registrations: the ONE extraction seam. Each loader is a function-scoped `import()` so
 * no host entry evaluates an engine eagerly (the `cli-startup-import-closure` pins). Extraction
 * swaps this table for the installed-plugin lookup; the host call sites never change.
 */
const BUILTIN_REPLAY_BACKEND_PLUGINS: {
  readonly [TId in ReplayBackendId]: () => Promise<ReplayBackendPlugin<TId>>;
} = {
  maestro: async () =>
    (await import('@agent-device/maestro/replay-backend')).maestroReplayBackendPlugin,
};

const loadedBackends = new Map<ReplayBackendId, Promise<ReplayBackend<ReplayBackendId>>>();

async function createReplayBackend(id: ReplayBackendId): Promise<ReplayBackend<ReplayBackendId>> {
  const plugin = await BUILTIN_REPLAY_BACKEND_PLUGINS[id]();
  const { createReplayBackendHost } = await import('./replay-backend-host.ts');
  return plugin.create(createReplayBackendHost());
}

/**
 * Resolves a backend once per process, memoizing the engine's single evaluation. A load failure
 * is NOT cached — a failed `import()` stays retryable, as it was at the pre-registry call sites
 * that imported fresh per invocation. The id's type is the grammar's `isReplayBackendId` guard, so
 * an unregistered value is rejected by the caller before it reaches here; engines never fall back
 * to one another.
 */
export function getReplayBackend(id: ReplayBackendId): Promise<ReplayBackend<ReplayBackendId>> {
  const cached = loadedBackends.get(id);
  if (cached) return cached;
  const loading = createReplayBackend(id).catch((error: unknown) => {
    loadedBackends.delete(id);
    throw error;
  });
  loadedBackends.set(id, loading);
  return loading;
}
