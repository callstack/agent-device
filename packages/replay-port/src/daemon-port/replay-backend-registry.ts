import type { SessionAction } from '@agent-device/contracts/session';
import type { ReplayBackendId } from '@agent-device/ad-script';
import type { ReplayCommand } from './command-types.ts';
import type { DaemonResponse } from '@agent-device/kernel/contracts';

/**
 * The replay backend registry (#3377).
 *
 * The host (the replay command, `test` discovery, request device binding, and the client-side
 * replay surface) reaches a non-native engine only through this module. A backend id resolves to
 * one registration thunk whose loading is memoized per process; nothing outside the backend's own
 * adapter module names an engine package. The Maestro plugin extraction (#3377) replaces the
 * builtin table with an installed-plugin lookup and changes no caller.
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
 * the adapter and engine behind it are reached the same way. Type imports are free.
 */

/**
 * Backend ids come from the format grammar's vocabulary (`@agent-device/ad-script`), so the
 * registry's keys and the `--maestro` flag's accepted values can never drift apart.
 */

/** What a backend reports about one source before any run: the shared scheduling vocabulary. */
export type ReplaySourceInspection = Readonly<{
  /** The flow's authored title, when the format carries one. */
  title: string | undefined;
  /** A static app target the entry resolves to, for advisory device binding. */
  appTarget: string | undefined;
}>;

/** Reads one flow file, or reports that it is unavailable (#1802 readers). */
export type ReplayOptionalSourceReader = (resolvedPath: string) => string | undefined;

export type ReplayBackendExportWarning = Readonly<{
  line: number;
  action: string;
  message: string;
}>;

export type ReplayBackendExportResult = Readonly<{
  yaml: string;
  warnings: ReplayBackendExportWarning[];
}>;

export type ReplayBackend = Readonly<{
  id: ReplayBackendId;
  /** Expands the entry flow's include closure into a path-to-text map (best effort, #1802). */
  collectSourceFiles(params: {
    entryPath: string;
    entrySource: string;
    env?: Readonly<Record<string, string>>;
    readSource: ReplayOptionalSourceReader;
  }): Record<string, string>;
  /** Reads title/app-target metadata from one source, without running it. Throws on an invalid flow. */
  inspectSource(source: string, sourcePath: string): ReplaySourceInspection;
  /** Runs one replay through the backend's engine, owning no session or wire state. */
  runReplay(command: ReplayCommand): Promise<DaemonResponse>;
  /** Converts a native `.ad` action list into the backend's own script format. */
  exportReplayScript(
    actions: SessionAction[],
    options: { actionLines?: number[]; metadata?: { env?: Record<string, string> } },
  ): ReplayBackendExportResult;
}>;

/**
 * Builtin registrations: the ONE extraction seam. Each thunk is the only place its backend's
 * package is named outside the backend's own adapter, and stays a function-scoped `import()` so
 * no host entry evaluates an engine eagerly (the `cli-startup-import-closure` pins). Extraction
 * swaps this table for the installed-plugin lookup; the host call sites never change.
 */
const BUILTIN_REPLAY_BACKENDS: Readonly<Record<ReplayBackendId, () => Promise<ReplayBackend>>> = {
  maestro: async () => (await import('./replay-maestro-backend.ts')).maestroBackend,
};

const loadedBackends = new Map<ReplayBackendId, Promise<ReplayBackend>>();

/**
 * Resolves a backend once per process, memoizing the engine's single evaluation. The id's type
 * is the grammar's `isReplayBackendId` guard, so an unregistered value is rejected by the caller
 * before it reaches here; engines never fall back to one another.
 */
export function getReplayBackend(id: ReplayBackendId): Promise<ReplayBackend> {
  const cached = loadedBackends.get(id);
  if (cached) return cached;
  const loading = BUILTIN_REPLAY_BACKENDS[id]();
  loadedBackends.set(id, loading);
  return loading;
}
