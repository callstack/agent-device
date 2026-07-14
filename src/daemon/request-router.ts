import {
  type DeviceInventoryProvider,
  withTargetDeviceResolutionScope,
} from '../core/dispatch-resolve.ts';
import { AppError, normalizeError, retriableForErrorCode } from '../kernel/errors.ts';
import { supportedPlatformsForCommand } from '../core/capabilities.ts';
import { timingSafeStringEqual } from '../utils/timing-safe-equal.ts';
import type { DaemonArtifactType, DaemonError, ResponseCost } from '../kernel/contracts.ts';
import type { CloudArtifactProvider } from '../cloud-artifacts.ts';
import type { DaemonInvokeFn, DaemonRequest, DaemonResponse, DaemonResponseData } from './types.ts';
import { RESPONSE_VIEWS } from './response-views.ts';
import { SessionStore } from './session-store.ts';
import { noActiveSessionError } from './handlers/response.ts';
import {
  type AndroidAdbProviderResolver,
  type AppleRunnerProviderResolver,
  type AppleToolProviderResolver,
  type AppLogProviderResolver,
  type LinuxToolProviderResolver,
  type RequestPlatformProviderScope,
  type RecordingProviderResolver,
  type WebProviderResolver,
  withRequestPlatformProviderScope,
} from './request-platform-providers.ts';
import {
  countDiagnosticEventsByPhase,
  emitDiagnostic,
  flushDiagnosticsToSessionFile,
  getDiagnosticsMeta,
  withDiagnosticsScope,
} from '../utils/diagnostics.ts';
import type { LeaseRegistry } from './lease-registry.ts';
import {
  loadGenericRequestHandlerModule,
  runRequestHandlerChain,
} from './request-handler-chain.ts';
import {
  createRequestExecutionScope,
  type LockedRequestScope,
  prepareLockedRequestScope,
  type RequestExecutionScope,
} from './request-execution-scope.ts';
import { buildRequestFinishedEvent, shouldRecordEventForRequest } from './session-event-log.ts';
import { canRunReplayScopedAction } from './daemon-command-registry.ts';
import { createAgentBrowserWebProvider } from '../platforms/web/agent-browser-provider.ts';
import type { LeaseLifecycleProvider } from './handlers/lease.ts';
import { openWebSessionNames } from './web-session-names.ts';

// ---------------------------------------------------------------------------
// Request handler API
// ---------------------------------------------------------------------------

export type RequestRouterDeps = {
  logPath: string;
  stateDir?: string;
  token: string;
  sessionStore: SessionStore;
  leaseRegistry: LeaseRegistry;
  androidAdbProvider?: AndroidAdbProviderResolver;
  appleRunnerProvider?: AppleRunnerProviderResolver;
  appleToolProvider?: AppleToolProviderResolver;
  linuxToolProvider?: LinuxToolProviderResolver;
  webProvider?: WebProviderResolver;
  appLogProvider?: AppLogProviderResolver;
  recordingProvider?: RecordingProviderResolver;
  deviceInventoryProvider?: DeviceInventoryProvider;
  leaseLifecycleProvider?: LeaseLifecycleProvider;
  cloudArtifactProvider?: CloudArtifactProvider;
  providerDeviceRuntimeScope?: <T>(task: () => Promise<T>) => Promise<T>;
  trackDownloadableArtifact: (opts: {
    artifactPath: string;
    tenantId?: string;
    artifactType: DaemonArtifactType | undefined;
    fileName?: string;
  }) => string;
};

export function createRequestHandler(deps: RequestRouterDeps): DaemonInvokeFn {
  const {
    logPath,
    stateDir,
    token,
    androidAdbProvider,
    appleRunnerProvider,
    appleToolProvider,
    linuxToolProvider,
    webProvider,
    appLogProvider,
    recordingProvider,
    deviceInventoryProvider,
    leaseLifecycleProvider,
    cloudArtifactProvider,
    providerDeviceRuntimeScope,
    trackDownloadableArtifact,
  } = deps;
  const { sessionStore, leaseRegistry } = deps;

  async function handleRequest(req: DaemonRequest): Promise<DaemonResponse> {
    const start = Date.now();
    const debug = Boolean(req.meta?.debug || req.flags?.verbose);
    return await withDiagnosticsScope(
      {
        session: req.session,
        requestId: req.meta?.requestId,
        command: req.command,
        debug,
        logPath,
      },
      async () => {
        const response = await runRequestWithinScope(req);
        // Phase 2 (typed errors) graft: enrich error responses with additive,
        // machine-readable signals — `supportedOn` for platform mismatches and
        // `retriable` for transient failures — so an agent self-corrects without a
        // wasted round-trip. Returned unchanged when neither applies, so the
        // default error wire shape is preserved.
        if (!response.ok) {
          // ADR 0012 decision 6, R7 (C5a): a command that finds no session but
          // hits a live repair tombstone gets `REPAIR_SESSION_EXPIRED` with
          // re-run guidance, never a bare SESSION_NOT_FOUND.
          const error = repairExpiredIfTombstoned(req, response.error, sessionStore);
          return { ok: false, error: enrichDaemonError(req.command, error) };
        }
        // Phase 4 (agent-cost) grafts on the success path. Runs inside the
        // diagnostics scope so cost can read this request's runner-round-trip tally.
        return applyAgentCostGrafts(req, response, start);
      },
    );
  }

  async function runRequestWithinScope(req: DaemonRequest): Promise<DaemonResponse> {
    if (!timingSafeStringEqual(req.token, token)) {
      return unauthorizedResponse();
    }

    let scope: RequestExecutionScope | undefined;
    try {
      return await withTargetDeviceResolutionScope(deviceInventoryProvider, async () => {
        scope = await createRequestExecutionScope({
          req,
          sessionStore,
          leaseRegistry,
        });
        return await executeRequestScope(scope);
      });
    } catch (error) {
      const response = finalizeThrownRequestError(error);
      recordThrownRequestEvent(sessionStore, scope, response);
      return response;
    }
  }

  async function executeRequestScope(
    scope: RequestExecutionScope,
    inheritedProviderScope?: RequestPlatformProviderScope,
  ): Promise<DaemonResponse> {
    const run = async (): Promise<DaemonResponse> => {
      const locked = prepareLockedRequestScope({
        scope,
        sessionStore,
        trackDownloadableArtifact,
      });
      if (locked.type === 'response') return locked.response;
      const lockedScope = locked.scope;
      const executeLocked = async (providerScope: RequestPlatformProviderScope) => {
        const runLockedRequest = async () =>
          await executeLockedRequest({
            lockedScope,
            providerScope,
            allowReplayActions: inheritedProviderScope === undefined,
          });
        return providerDeviceRuntimeScope
          ? await providerDeviceRuntimeScope(runLockedRequest)
          : await runLockedRequest();
      };

      return inheritedProviderScope
        ? await executeLocked(inheritedProviderScope)
        : await withRequestPlatformProviderScope(
            {
              req: lockedScope.req,
              existingSession: lockedScope.existingSession,
              providers: {
                androidAdbProvider,
                appleRunnerProvider,
                appleToolProvider,
                linuxToolProvider,
                webProvider:
                  webProvider ??
                  (shouldUseDefaultWebProvider(lockedScope)
                    ? createDefaultWebProvider(stateDir, sessionStore)
                    : undefined),
                appLogProvider,
                recordingProvider,
              },
            },
            executeLocked,
          );
    };

    return inheritedProviderScope ? await scope.runAdmitted(run) : await scope.runLocked(run);
  }

  async function executeLockedRequest(params: {
    lockedScope: LockedRequestScope;
    providerScope: RequestPlatformProviderScope;
    allowReplayActions: boolean;
  }): Promise<DaemonResponse> {
    const { lockedScope, providerScope, allowReplayActions } = params;
    const handlerResponse = await runRequestHandlerChain({
      req: lockedScope.req,
      sessionName: lockedScope.sessionName,
      logPath: lockedScope.logPath,
      sessionStore,
      leaseRegistry,
      leaseLifecycleProvider,
      cloudArtifactProvider,
      invoke: handleRequest,
      invokeReplayAction: allowReplayActions
        ? createReplayScopedActionInvoker(lockedScope, providerScope)
        : undefined,
      androidAdbExecutor: providerScope.androidAdbExecutor,
      contextFromFlags: lockedScope.handlerContextFromFlags,
    });
    if (handlerResponse) return lockedScope.finalize(handlerResponse);

    return await dispatchGenericForLockedScope({
      lockedScope,
      logPath: lockedScope.logPath,
      sessionStore,
    });
  }

  function createReplayScopedActionInvoker(
    parentScope: LockedRequestScope,
    providerScope: RequestPlatformProviderScope,
  ): DaemonInvokeFn {
    return async (req) => {
      if (!canRunReplayActionInCurrentScope(req, parentScope)) return await handleRequest(req);
      if (!timingSafeStringEqual(req.token, token)) {
        return unauthorizedResponse();
      }

      let childScope: RequestExecutionScope | undefined;
      try {
        childScope = await createRequestExecutionScope({ req, sessionStore, leaseRegistry });
        return childScope.sessionName === parentScope.sessionName
          ? await executeRequestScope(childScope, providerScope)
          : await executeRequestScope(childScope);
      } catch (error) {
        const response = finalizeThrownRequestError(error);
        recordThrownRequestEvent(sessionStore, childScope, response);
        return response;
      }
    };
  }

  return handleRequest;
}

const createDefaultWebProvider =
  (stateDir: string | undefined, sessionStore: SessionStore): WebProviderResolver =>
  ({ req, session }) =>
    createAgentBrowserWebProvider({
      session: session?.name ?? req.session,
      stateDir,
      openWebSessionNames: () => openWebSessionNames(sessionStore),
    });

function shouldUseDefaultWebProvider(scope: LockedRequestScope): boolean {
  return scope.existingSession?.device.platform === 'web' || scope.req.flags?.platform === 'web';
}

function unauthorizedResponse(): DaemonResponse {
  return {
    ok: false,
    error: normalizeError(new AppError('UNAUTHORIZED', 'Invalid token')),
  };
}

async function dispatchGenericForLockedScope(params: {
  lockedScope: LockedRequestScope;
  logPath: string;
  sessionStore: SessionStore;
}): Promise<DaemonResponse> {
  const { lockedScope, logPath, sessionStore } = params;
  const session = sessionStore.get(lockedScope.sessionName);
  if (!session) {
    return lockedScope.finalize(noActiveSessionError());
  }

  const { dispatchGenericCommand } = await loadGenericRequestHandlerModule();
  const dispatchResponse = await dispatchGenericCommand({
    req: lockedScope.req,
    session,
    sessionName: lockedScope.sessionName,
    logPath,
    sessionStore,
    contextFromFlags: lockedScope.contextFromFlags,
  });
  return lockedScope.finalize(dispatchResponse);
}

function canRunReplayActionInCurrentScope(
  req: DaemonRequest,
  parentScope: LockedRequestScope,
): boolean {
  return req.session === parentScope.sessionName && canRunReplayScopedAction(req.command);
}

function finalizeThrownRequestError(error: unknown): DaemonResponse {
  emitDiagnostic({
    level: 'error',
    phase: 'request_failed',
    data: {
      error: error instanceof Error ? error.message : String(error),
    },
  });
  const details = getDiagnosticsMeta();
  const logPathOnFailure = flushDiagnosticsToSessionFile({ force: true }) ?? undefined;
  const normalizedError = normalizeError(error, {
    diagnosticId: details.diagnosticId,
    logPath: logPathOnFailure,
  });
  return { ok: false, error: normalizedError };
}

function recordThrownRequestEvent(
  sessionStore: SessionStore,
  scope: RequestExecutionScope | undefined,
  response: DaemonResponse,
): void {
  if (!scope || !shouldRecordEventForRequest(scope.req)) return;
  sessionStore.recordEvent(
    scope.sessionName,
    buildRequestFinishedEvent({
      req: scope.req,
      response,
      durationMs: Math.max(0, Date.now() - scope.startedAtMs),
    }),
  );
}

/**
 * ADR 0012 decision 6, R7 (C5a, BLOCKER 2): when a request finds no session
 * (SESSION_NOT_FOUND) but a live repair tombstone exists for its session key,
 * rewrite the error to an actionable recovery error. Any other error, or the
 * absence of a (non-expired) tombstone, passes through untouched.
 *
 * BLOCKER 2: a tombstone carrying `commitFailure` means the transaction
 * actually COMPLETED and a commit was attempted at teardown but FAILED (e.g.
 * no-clobber refusal, a filesystem error) — that is a materially different,
 * more specific situation than "reaped before it ever finished", so it gets
 * its own `REPAIR_COMMIT_FAILED` code carrying the real cause, rather than
 * being folded into the generic `REPAIR_SESSION_EXPIRED` expiry message.
 */
function repairExpiredIfTombstoned(
  req: DaemonRequest,
  error: DaemonError,
  sessionStore: SessionStore,
): DaemonError {
  if (error.code !== 'SESSION_NOT_FOUND') return error;
  const tombstone = sessionStore.readRepairTombstone(req.session);
  if (!tombstone) return error;
  const reRun = tombstone.sourcePath
    ? `re-run: replay ${tombstone.sourcePath} --save-script`
    : 're-run your replay <script> --save-script from the start';
  if (tombstone.commitFailure) {
    return normalizeError(
      new AppError(
        'REPAIR_COMMIT_FAILED',
        `The repair transaction for session "${req.session}" completed, but committing its healed script failed at teardown: ${tombstone.commitFailure.message}. ${reRun}.`,
      ),
    );
  }
  return normalizeError(
    new AppError(
      'REPAIR_SESSION_EXPIRED',
      `The --save-script repair session "${req.session}" was reaped before it was finalized (idle-reap); ${reRun}.`,
    ),
  );
}

// Phase 2 typed-error graft: add machine-readable signals to an error response.
// Returns the error unchanged unless a signal applies, so the default wire shape
// is preserved for the common codes.
function enrichDaemonError(command: string, error: DaemonError): DaemonError {
  const supportedPlatforms =
    error.code === 'UNSUPPORTED_OPERATION' || error.code === 'UNSUPPORTED_PLATFORM'
      ? supportedPlatformsForCommand(command)
      : [];
  const supportedOn = supportedPlatforms.length > 0 ? supportedPlatforms.join(', ') : undefined;
  // A throw-site classification (lifted from details by normalizeError) wins
  // over the conservative code-level policy.
  const retriable = error.retriable ?? retriableForErrorCode(error.code);
  if (supportedOn === undefined && retriable === undefined) return error;
  return {
    ...error,
    ...(retriable !== undefined ? { retriable } : {}),
    ...(supportedOn !== undefined ? { supportedOn } : {}),
  };
}

// Phase 4 (agent-cost) success-path grafts: a leveled response view and an
// opt-in cost block, both purely additive. With responseLevel `default` (or
// unset) AND no registered view AND no --cost, the original `response` object is
// returned unchanged — byte-identical to today (Maestro `.ad` recompare safe).
function applyAgentCostGrafts(
  req: DaemonRequest,
  response: Extract<DaemonResponse, { ok: true }>,
  startedAt: number,
): DaemonResponse {
  const viewed = applyResponseLevelView(req, response);
  if (!req.meta?.includeCost) return viewed;
  const cost = buildResponseCost(response.data, startedAt);
  return { ok: true, data: { ...(viewed.data ?? {}), cost } };
}

// Returns the response untouched when responseLevel is `default` (or unset) or no
// view is registered for the command — preserving today's byte-exact wire shape.
function applyResponseLevelView(
  req: DaemonRequest,
  response: Extract<DaemonResponse, { ok: true }>,
): Extract<DaemonResponse, { ok: true }> {
  const level = req.meta?.responseLevel ?? 'default';
  if (level === 'default') return response;
  const view = RESPONSE_VIEWS[req.command];
  return view ? { ok: true, data: view(response.data ?? {}, level) } : response;
}

// Diagnostic phases emitted once per real iOS-runner round-trip. `..._command_send`
// is the command itself; `..._readiness_preflight` is the pre-command uptime probe
// (a real network round-trip). The `..._skipped` / `..._recovered` markers do NOT
// hit the runner and are intentionally excluded.
const RUNNER_ROUND_TRIP_PHASES = [
  'ios_runner_command_send',
  'ios_runner_readiness_preflight',
] as const;

function buildResponseCost(
  originalData: DaemonResponseData | undefined,
  startedAt: number,
): ResponseCost {
  const cost: ResponseCost = {
    wallClockMs: Date.now() - startedAt,
    // Counts this request's real runner round-trips from the flush-surviving
    // diagnostics phase tally. Reads 0 when no runner was hit (e.g. a no-op or a
    // command served entirely from the daemon). Must run inside the request's
    // diagnostics scope (see `applyAgentCostGrafts` call site).
    runnerRoundTrips: countDiagnosticEventsByPhase(RUNNER_ROUND_TRIP_PHASES),
  };
  // nodeCount reads the ORIGINAL node tree (the digest view may have already
  // collapsed `data.nodes`), so the count stays accurate.
  const nodes = originalData?.nodes;
  if (Array.isArray(nodes)) cost.nodeCount = nodes.length;
  return cost;
}
