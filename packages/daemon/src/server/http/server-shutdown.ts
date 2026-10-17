import type { ProviderDeviceRuntime } from '@agent-device/contracts/device';
import { normalizeError, type NormalizedError } from '@agent-device/kernel/errors';
import type { DaemonServer } from './transport.ts';
import { sleep } from '@agent-device/host-kit/retry';
import {
  createRequestCancelRuntimeState,
  type RuntimeStateHandle,
} from '@agent-device/host-kit/request';
import type { RuntimeHintValues } from '@agent-device/contracts/application-lifecycle-runtime';
import { SessionStore } from '../../core/session-store.ts';
import type { SessionRef, SessionState } from '../../core/session-state.ts';
import type { PlatformResourceCleanup } from '../../core/platform-resource-cleanup.ts';
import { createProviderDeviceAdmissionRuntimeState } from '../../core/provider-device-admission.ts';
import { createInteractorResolutionRuntimeState } from '../../core/interactor-resolution.ts';
import { createArtifactTrackingRuntimeState } from '../../resources/artifact-tracking.ts';
import { createResumableUploadRuntimeState } from '../resumable-upload.ts';
import { createMaterializedPathRuntimeState } from '../../sessions/materialized-path-registry.ts';
import { stopSessionAppLog, teardownSessionResources } from '../../sessions/session-teardown.ts';
import { resolveDaemonSessionTeardownTimeoutMs } from '../../sessions/session-teardown-budget.ts';
import { runtimeHintValues } from '../../sessions/session-runtime.ts';

const DAEMON_SHUTDOWN_TIMEOUT_MS = 5_000;

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
      let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
      await new Promise<void>((resolve) => {
        timeoutHandle = setTimeout(() => {
          forceCloseServer(server);
          resolve();
        }, timeoutMs);
        try {
          server.close(() => resolve());
        } catch {
          resolve();
        }
      });
      if (timeoutHandle) clearTimeout(timeoutHandle);
    }),
  );
}

/** What a closed daemon runtime leaves behind, by kind of resource. */
export type ShutdownReport = {
  /** Provider lease releases, by lease id. `unknown` was still in flight when the budget ran out. */
  providerReleases: { completed: string[]; pending: string[]; unknown: string[] };
  /** Device runners, by device id: `handedOff` was left running for the next daemon. */
  runners: { stopped: string[]; handedOff: string[] };
  sessions: { closed: number; failed: number };
  plugins: { disposed: string[]; failed: { provider: string; error: NormalizedError }[] };
};

export type ProviderRuntimeDisposal = Readonly<{
  /** Disposes every provider runtime once; later calls return the first call's result. */
  dispose(): Promise<ShutdownReport['plugins']>;
}>;

export function createProviderRuntimeDisposal(
  runtimes: readonly Pick<ProviderDeviceRuntime, 'provider' | 'shutdown'>[],
): ProviderRuntimeDisposal {
  let disposal: Promise<ShutdownReport['plugins']> | undefined;
  return {
    dispose: () =>
      (disposal ??= (async () => {
        const report: ShutdownReport['plugins'] = { disposed: [], failed: [] };
        await Promise.all(
          runtimes.map(async (runtime) => {
            try {
              await runtime.shutdown();
              report.disposed.push(runtime.provider);
            } catch (error) {
              report.failed.push({ provider: runtime.provider, error: normalizeError(error) });
            }
          }),
        );
        return report;
      })()),
  };
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
    runtimeHints: RuntimeHintValues,
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
  const runtimeHints = runtimeHintValues(
    current ? sessionStore.getRuntimeHints(ref.address) : undefined,
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
  const genericTeardownSucceeded = await Promise.race([
    teardown,
    sleep(timeoutMs).then(() => {
      stderr.write(`Daemon session teardown timed out (${session.name}).\n`);
      return false;
    }),
  ]);
  const teardownSucceeded = appLogTeardownSucceeded && genericTeardownSucceeded;
  // ADR 0012 decision 6, R7 + commit semantics (C2/C5a): commit the healed
  // `.ad` iff the repair transaction completed, else leave a bounded
  // `REPAIR_SESSION_EXPIRED` tombstone for the reaped-before-finalize case.
  sessionStore.finalizeRepairTeardown(ref);
  if (teardownSucceeded) await afterSuccessfulTeardown?.(session);
  sessionStore.retire(ref);
  return teardownSucceeded;
}

export type RuntimeContext = Readonly<{
  run<T>(fn: () => T): T;
  /** Adds state the composition contributed and binds it for the rest of the start. */
  extend(handles: readonly RuntimeStateHandle[]): void;
  dispose(): void;
}>;

/** The per-runtime state of every module that keeps some, in the order it is entered. */
function createDaemonRuntimeStates(): RuntimeStateHandle[] {
  return [
    createRequestCancelRuntimeState(),
    createProviderDeviceAdmissionRuntimeState(),
    createInteractorResolutionRuntimeState(),
    createArtifactTrackingRuntimeState(),
    createResumableUploadRuntimeState(),
    createMaterializedPathRuntimeState(),
  ];
}

/** The context one daemon runtime enters: every module's per-runtime state, composed in order. */
export function createRuntimeContext(): RuntimeContext {
  const states = createDaemonRuntimeStates();
  return {
    run: (fn) => states.reduceRight((next, state) => () => state.run(next), fn)(),
    extend: (handles) => {
      for (const handle of handles) {
        states.push(handle);
        handle.enter();
      }
    },
    dispose: () => {
      for (const state of states) state.dispose();
    },
  };
}
