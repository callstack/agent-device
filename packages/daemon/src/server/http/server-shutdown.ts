import type {
  PluginCleanupOutcome,
  PluginInventoryEntry,
} from '@agent-device/contracts/plugin-inventory';
import { normalizeError, type NormalizedError } from '@agent-device/kernel/errors';
import { settleWithin, type SettleWithinOutcome } from '@agent-device/host-kit/settle-within';
import type { DaemonServer } from './transport.ts';
import type { RuntimeHintsApplicationInput } from '@agent-device/contracts/application-lifecycle-runtime';
import { SessionStore } from '../../core/session-store.ts';
import type { SessionRef, SessionState } from '../../core/session-state.ts';
import type { PlatformResourceCleanup } from '../../core/platform-resource-cleanup.ts';
import { stopSessionAppLog, teardownSessionResources } from '../../sessions/session-teardown.ts';
import { resolveDaemonSessionTeardownTimeoutMs } from '../../sessions/session-teardown-budget.ts';
import { runtimeHintsClearInput } from '../../sessions/session-runtime.ts';

const DAEMON_SHUTDOWN_TIMEOUT_MS = 5_000;
const DAEMON_PLUGIN_SHUTDOWN_TIMEOUT_MS = 5_000;

function forceCloseServer(server: DaemonServer): void {
  server.destroyConnections?.();
  const closeAllConnections =
    'closeAllConnections' in server ? server.closeAllConnections : undefined;
  if (typeof closeAllConnections === 'function') {
    closeAllConnections.call(server);
    return;
  }
  const closeIdleConnections =
    'closeIdleConnections' in server ? server.closeIdleConnections : undefined;
  if (typeof closeIdleConnections === 'function') closeIdleConnections.call(server);
}

export async function closeDaemonServers(
  servers: DaemonServer[],
  timeoutMs: number = DAEMON_SHUTDOWN_TIMEOUT_MS,
): Promise<void> {
  await Promise.all(
    servers.map(async (server) => {
      const outcome = await settleWithin(
        () =>
          new Promise<void>((resolve) => {
            try {
              server.close(() => resolve());
            } catch {
              resolve();
            }
          }),
        timeoutMs,
      );
      if (outcome.kind === 'deadline') forceCloseServer(server);
    }),
  );
}

/** What a closed daemon runtime leaves behind, by kind of resource. */
export type ShutdownReport = {
  /** Provider lease releases, by lease id. `unknown` was still in flight when the budget ran out. */
  providerReleases: { completed: string[]; pending: string[]; unknown: string[] };
  /** Device runners, by device id: `handedOff` was left running for the next daemon. */
  runners: { stopped: string[]; handedOff: string[] };
  /**
   * Requests in flight at close. `abandoned` ones ignored cancellation past the drain budget and may
   * still be running, so the registration stays held while this process lives.
   */
  requests: { drained: number; abandoned: number };
  sessions: { closed: number; failed: number };
  /** `pending` exceeded the shutdown budget; `failed` settled with an owner error. Both retain registration. */
  platformOwners: 'closed' | 'pending' | 'failed';
  /** `pending` plugins were still shutting down when the budget ran out. */
  plugins: {
    disposed: string[];
    failed: {
      provider?: string;
      backend?: string;
      platform?: string;
      source?: PluginCleanupOutcome['source'];
      step: 'shutdown' | 'dispose';
      error: NormalizedError;
    }[];
    pending: string[];
  };
};

/**
 * The lines that say what a close left unfinished, for the executable to write where the operator
 * looks (stderr is the daemon log for a detached daemon). A clean close yields none.
 */
export function describeUnfinishedShutdownWork(report: ShutdownReport): string[] {
  const lines: string[] = [];
  if (report.requests.abandoned > 0) {
    lines.push(
      `Daemon shutdown: ${report.requests.abandoned} request(s) ignored cancellation and may still be running; the daemon registration stays held until this process exits.`,
    );
  }
  if (report.platformOwners === 'pending') {
    lines.push(
      'Daemon shutdown: platform owners were still shutting down when the budget ran out; the daemon registration stays held until this process exits.',
    );
  }
  if (report.platformOwners === 'failed') {
    lines.push(
      'Daemon shutdown: platform owner shutdown failed; the daemon registration stays held until this process exits.',
    );
  }
  for (const provider of report.plugins.pending) {
    lines.push(
      `Daemon shutdown: plugin ${provider} was still shutting down when the budget ran out.`,
    );
  }
  for (const failure of report.plugins.failed) {
    lines.push(
      `Daemon shutdown: plugin ${failure.provider ?? `replay backend ${failure.backend}`} failed to ${failure.step === 'shutdown' ? 'shut down' : 'dispose'}: ${failure.error.message}`,
    );
  }
  const { pending, unknown } = report.providerReleases;
  if (pending.length > 0) {
    lines.push(`Daemon shutdown: provider lease release still pending for ${pending.join(', ')}.`);
  }
  if (unknown.length > 0) {
    lines.push(
      `Daemon shutdown: provider lease release outcome unknown for ${unknown.join(', ')}.`,
    );
  }
  if (report.sessions.failed > 0) {
    lines.push(`Daemon shutdown: ${report.sessions.failed} session(s) failed to tear down.`);
  }
  return lines;
}

/**
 * Waits for the runtime to close and writes what it left unfinished to `stderr`. Whoever started the
 * close (a signal, the idle reap, a quiesce), this is the one place the executable learns of it, and
 * the registration may be held on purpose, so a clean close writes nothing and any other says why.
 */
export async function reportDaemonClose(params: {
  closed: Promise<ShutdownReport>;
  stderr: WritableOutput;
}): Promise<{ failed: boolean }> {
  try {
    const report = await params.closed;
    for (const line of describeUnfinishedShutdownWork(report)) params.stderr.write(`${line}\n`);
    return { failed: report.platformOwners === 'failed' };
  } catch (error) {
    params.stderr.write(`Daemon shutdown error: ${normalizeError(error).message}\n`);
    return { failed: true };
  }
}

export type PluginClose = Readonly<{
  /** Closes the plugin registry once; later calls return the first call's report. */
  close(): Promise<ShutdownReport['plugins']>;
}>;

/**
 * The daemon's one plugin cleanup: the registry closes each plugin (runtime shutdown, then dispose)
 * and answers with a per-plugin outcome. Bounded, because one plugin that never finishes must not
 * hold the whole close: past the budget every registered plugin is reported pending while its cleanup
 * keeps running.
 */
export function createPluginClose(params: {
  close: () => Promise<readonly PluginCleanupOutcome[]>;
  inventory: readonly PluginInventoryEntry[];
  timeoutMs?: number;
}): PluginClose {
  let closing: Promise<ShutdownReport['plugins']> | undefined;
  const cleanupOwners = params.inventory.flatMap((entry) =>
    entry.state === 'active'
      ? [{ provider: entry.provider, backend: entry.backend, platform: entry.platform }]
      : [],
  );
  return {
    close: () =>
      (closing ??= (async () => {
        let outcome: SettleWithinOutcome<readonly PluginCleanupOutcome[]>;
        try {
          outcome = await settleWithin(
            params.close,
            params.timeoutMs ?? DAEMON_PLUGIN_SHUTDOWN_TIMEOUT_MS,
          );
        } catch (error) {
          const normalized = normalizeError(error);
          return {
            disposed: [],
            failed: cleanupOwners.map((identity) => ({
              ...identity,
              step: 'shutdown' as const,
              error: normalized,
            })),
            pending: [],
          };
        }
        if (outcome.kind === 'deadline') {
          return {
            disposed: [],
            failed: [],
            pending: cleanupOwners.map(pluginCleanupName),
          };
        }
        return reportCleanupOutcomes(outcome.value);
      })()),
  };
}

function reportCleanupOutcomes(
  outcomes: readonly PluginCleanupOutcome[],
): ShutdownReport['plugins'] {
  const report: ShutdownReport['plugins'] = { disposed: [], failed: [], pending: [] };
  for (const { source, shutdown, dispose, ...identity } of outcomes) {
    for (const [step, result] of [
      ['shutdown', shutdown],
      ['dispose', dispose],
    ] as const) {
      if (result.status !== 'failed') continue;
      const { code, message, hint } = result.error;
      report.failed.push({
        ...identity,
        source,
        step,
        error: { code, message, ...(hint === undefined ? {} : { hint }) },
      });
    }
    if (shutdown.status === 'ok' && dispose.status === 'ok')
      report.disposed.push(pluginCleanupName(identity));
  }
  return report;
}

function pluginCleanupName(identity: {
  provider?: string;
  backend?: string;
  platform?: string;
}): string {
  return (
    identity.provider ??
    (identity.platform ? `platform:${identity.platform}` : `replay-backend:${identity.backend}`)
  );
}

/** Undoes startup work in reverse order; a step that throws never stops the ones before it. */
export type StartupRollback = Readonly<{
  onRollback(step: () => Promise<void> | void): void;
  run(): Promise<void>;
}>;

export function createStartupRollback(): StartupRollback {
  const steps: Array<() => Promise<void> | void> = [];
  return {
    onRollback: (step) => {
      steps.push(step);
    },
    run: async () => {
      for (const step of steps.splice(0).reverse()) {
        await Promise.resolve()
          .then(step)
          .catch(() => {});
      }
    },
  };
}

export type WritableOutput = {
  write: (chunk: string) => unknown;
};

async function settleDaemonTeardownStep(params: {
  session: SessionState;
  stderr: WritableOutput;
  resource: 'app-log' | 'session' | 'lifecycle';
  teardown: () => Promise<unknown>;
}): Promise<boolean> {
  const { session, stderr, resource, teardown } = params;
  try {
    await teardown();
    return true;
  } catch (error) {
    stderr.write(
      `Daemon ${resource} teardown error (${session.name}): ${
        error instanceof Error ? error.message : String(error)
      }\n`,
    );
    return false;
  }
}

/**
 * Daemon-shutdown teardown of one session: bounded resource cleanup (budget
 * from {@link resolveDaemonSessionTeardownTimeoutMs}, resolved BEFORE cleanup
 * starts since finalizing the recording detaches `session.screenRecording`), then the
 * repair-commit finalization and session deletion. Cleanup failures — including
 * a recorder that could not be finalized — surface on stderr instead of being
 * silently swallowed.
 */
export async function teardownDaemonSessionForShutdown(params: {
  ref: SessionRef;
  sessionStore: SessionStore;
  stderr: WritableOutput;
  platformCleanup: PlatformResourceCleanup;
  finalizeApplicationLifecycle?: (
    session: SessionState,
    runtimeHints: RuntimeHintsApplicationInput,
  ) => Promise<void>;
  afterSuccessfulTeardown?: (session: SessionState) => Promise<void>;
}): Promise<boolean> {
  const {
    ref,
    sessionStore,
    stderr,
    platformCleanup,
    finalizeApplicationLifecycle,
    afterSuccessfulTeardown,
  } = params;
  const current = sessionStore.resolveCurrent(ref);
  const session = current ?? ref.session;
  const runtimeHints = runtimeHintsClearInput(
    current ? sessionStore.getStoredRuntimeHints(ref.address) : undefined,
    session.appBundleId,
  );
  const timeoutMs = resolveDaemonSessionTeardownTimeoutMs(session);
  // The ownership-fenced app-log side effect must settle while this process
  // still owns the daemon lock. It is intentionally outside the generic
  // teardown race so lock release and runtime shutdown cannot overtake it.

  const appLogTeardownSucceeded = await settleDaemonTeardownStep({
    session,
    stderr,
    resource: 'app-log',
    teardown: async () => await stopSessionAppLog({ ref, sessionStore }),
  });
  const sessionAfterAppLog = sessionStore.resolveCurrent(ref) ?? session;
  const teardown = (async () => {
    const genericTeardownSucceeded = await settleDaemonTeardownStep({
      session,
      stderr,
      resource: 'session',
      teardown: async () =>
        await teardownSessionResources({
          appLog: 'already-settled',
          ref,
          sessionStore,
          platformCleanup,
        }),
    });
    const lifecycleTeardownSucceeded = finalizeApplicationLifecycle
      ? await settleDaemonTeardownStep({
          session,
          stderr,
          resource: 'lifecycle',
          teardown: async () =>
            await finalizeApplicationLifecycle(sessionAfterAppLog, runtimeHints),
        })
      : true;
    return genericTeardownSucceeded && lifecycleTeardownSucceeded;
  })();
  let timedOut = false;
  let genericTeardownSucceeded = false;
  try {
    const teardownOutcome = await settleWithin(async () => await teardown, timeoutMs);
    if (teardownOutcome.kind === 'deadline') timedOut = true;
    else genericTeardownSucceeded = teardownOutcome.value;
  } catch {
    // A teardown that rejects is a failed teardown; its own step already wrote why to stderr.
  }
  if (timedOut) {
    stderr.write(`Daemon session teardown timed out (${session.name}).\n`);
  }
  const teardownSucceeded = appLogTeardownSucceeded && genericTeardownSucceeded;
  // ADR 0012 decision 6, R7 + commit semantics (C2/C5a): commit the healed
  // `.ad` iff the repair transaction completed, else leave a bounded
  // `REPAIR_SESSION_EXPIRED` tombstone for the reaped-before-finalize case.
  sessionStore.finalizeRepairTeardown(ref);
  if (teardownSucceeded) await afterSuccessfulTeardown?.(session);
  sessionStore.retire(ref);
  return teardownSucceeded;
}
