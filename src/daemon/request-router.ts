import {
  type DeviceInventoryProvider,
  withTargetDeviceResolutionScope,
} from '../core/dispatch-resolve.ts';
import { AppError, normalizeError } from '../utils/errors.ts';
import { timingSafeStringEqual } from '../utils/timing-safe-equal.ts';
import type { ResponseCost } from '../contracts.ts';
import type { DaemonInvokeFn, DaemonRequest, DaemonResponse } from './types.ts';
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
  emitDiagnostic,
  flushDiagnosticsToSessionFile,
  getDiagnosticsMeta,
  withDiagnosticsScope,
} from '../utils/diagnostics.ts';
import type { LeaseRegistry } from './lease-registry.ts';
import { dispatchGenericCommand } from './request-generic-dispatch.ts';
import { runRequestHandlerChain } from './request-handler-chain.ts';
import {
  createRequestExecutionScope,
  type LockedRequestScope,
  prepareLockedRequestScope,
  type RequestExecutionScope,
} from './request-execution-scope.ts';
import { canRunReplayScopedAction } from './daemon-command-registry.ts';
import { createAgentBrowserWebProvider } from '../platforms/web/agent-browser-provider.ts';

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
  trackDownloadableArtifact: (opts: {
    artifactPath: string;
    tenantId?: string;
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
    trackDownloadableArtifact,
  } = deps;
  const { sessionStore, leaseRegistry } = deps;

  async function handleRequest(req: DaemonRequest): Promise<DaemonResponse> {
    const start = Date.now();
    const debug = Boolean(req.meta?.debug || req.flags?.verbose);
    const response = await withDiagnosticsScope(
      {
        session: req.session,
        requestId: req.meta?.requestId,
        command: req.command,
        debug,
        logPath,
      },
      async () => {
        if (!timingSafeStringEqual(req.token, token)) {
          return unauthorizedResponse();
        }

        try {
          return await withTargetDeviceResolutionScope(deviceInventoryProvider, async () => {
            const scope = await createRequestExecutionScope({
              req,
              sessionStore,
              leaseRegistry,
            });
            return await executeRequestScope(scope);
          });
        } catch (error) {
          return finalizeThrownRequestError(error);
        }
      },
    );
    // Phase 4 (agent-cost) graft: cost is purely additive and opt-in. With the
    // flag off — or on an error response — the serialized DaemonResponse is
    // byte-identical to today (Maestro `.ad` recompare diffs it). Mirrors the
    // conditional `registerDownloadableArtifacts` spread in request-finalization.
    if (!req.meta?.includeCost || !response.ok) return response;
    const cost: ResponseCost = { wallClockMs: Date.now() - start };
    return { ok: true, data: { ...(response.data ?? {}), cost } };
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
      const executeLocked = async (providerScope: RequestPlatformProviderScope) =>
        await executeLockedRequest({
          lockedScope,
          providerScope,
          allowReplayActions: inheritedProviderScope === undefined,
        });

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
                    ? createDefaultWebProvider(stateDir)
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

      try {
        const childScope = await createRequestExecutionScope({ req, sessionStore, leaseRegistry });
        return childScope.sessionName === parentScope.sessionName
          ? await executeRequestScope(childScope, providerScope)
          : await handleRequest(req);
      } catch (error) {
        return finalizeThrownRequestError(error);
      }
    };
  }

  return handleRequest;
}

const createDefaultWebProvider =
  (stateDir: string | undefined): WebProviderResolver =>
  ({ req, session }) =>
    createAgentBrowserWebProvider({ session: session?.name ?? req.session, stateDir });

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
