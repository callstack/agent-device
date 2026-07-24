import type {
  DaemonRequest as SharedDaemonRequest,
  DaemonResponse as SharedDaemonResponse,
} from '../types.ts';
import type { RequestProgressSink } from '../../request/progress.ts';
import { AppError } from '../../kernel/errors.ts';
import { createRequestId, emitDiagnostic, withDiagnosticTimer } from '../../utils/diagnostics.ts';
import { INTERNAL_COMMANDS, PUBLIC_COMMANDS } from '../../command-catalog.ts';
import { prepareRemoteRequestArtifacts } from '../../remote/daemon-artifacts.ts';
import {
  attachActiveSessionAddressHint,
  attachRepairSessionAddressHint,
  cleanupDaemonAfterRequest,
  ensureDaemon,
  isActiveReplaySessionResponse,
  isHeldRepairDivergence,
  resolveClientSettings,
  type DaemonClientSettings,
  type EnsuredDaemon,
} from './daemon-client-lifecycle.ts';
import { sendRequest } from './daemon-client-transport.ts';
import { resolveDaemonRequestTimeoutMs } from './daemon-client-timeout.ts';

export type DaemonRequest = SharedDaemonRequest;
export type DaemonResponse = SharedDaemonResponse;
type DaemonTransportOptions = {
  onProgress?: RequestProgressSink;
};

export async function sendToDaemon(
  req: Omit<DaemonRequest, 'token'>,
  options: DaemonTransportOptions = {},
): Promise<DaemonResponse> {
  const requestId = req.meta?.requestId ?? createRequestId();
  const debug = Boolean(req.meta?.debug || req.flags?.verbose);
  const settings = resolveClientSettings(req);
  const requestTimeoutMs = resolveDaemonRequestTimeoutMs(req);
  const daemon = await withDiagnosticTimer(
    'daemon_startup',
    async () => await ensureDaemon(settings),
    { requestId, session: req.session },
  );
  const info = daemon.info;
  const preparedRemoteRequest = await prepareRemoteRequestArtifacts(req, info);
  writeInstallInProgressNotice(req.command);

  const request: DaemonRequest = {
    ...req,
    positionals: preparedRemoteRequest.positionals,
    flags: preparedRemoteRequest.flags,
    token: info.token,
    meta: {
      ...(req.meta ?? {}),
      requestId,
      debug,
      includeCost: req.meta?.includeCost,
      cwd: req.meta?.cwd,
      sessionExplicit: req.meta?.sessionExplicit,
      tenantId: req.meta?.tenantId ?? req.flags?.tenant,
      runId: req.meta?.runId ?? req.flags?.runId,
      leaseId: req.meta?.leaseId ?? req.flags?.leaseId,
      sessionIsolation: req.meta?.sessionIsolation ?? req.flags?.sessionIsolation,
      lockPolicy: req.meta?.lockPolicy,
      lockPlatform: req.meta?.lockPlatform,
      ...(preparedRemoteRequest.uploadedArtifactId
        ? { uploadedArtifactId: preparedRemoteRequest.uploadedArtifactId }
        : {}),
      ...(preparedRemoteRequest.clientArtifactPaths
        ? { clientArtifactPaths: preparedRemoteRequest.clientArtifactPaths }
        : {}),
      ...(preparedRemoteRequest.installSource
        ? { installSource: preparedRemoteRequest.installSource }
        : {}),
    },
  };
  emitDiagnostic({
    level: 'info',
    phase: 'daemon_request_prepare',
    data: {
      requestId,
      command: req.command,
      session: req.session,
    },
  });
  return await performDaemonRequestWithCleanup(req, daemon, settings, async () => {
    const response = await withDiagnosticTimer(
      'daemon_request',
      async () =>
        await sendRequest(
          info,
          request,
          settings.transportPreference,
          settings.paths,
          requestTimeoutMs,
          options,
        ),
      { requestId, command: req.command },
    );
    return withActiveSessionAddressHint(
      withRepairSessionAddressHintIfOwned(response, settings),
      req,
      settings,
    );
  });
}

/**
 * ADR 0012 decision 6 (BLOCKER 2, third follow-up): runs `send` and ALWAYS
 * runs cleanup afterward, using cleanup's result (not `send`'s raw result) as
 * the response the caller actually receives — cleanup can discover a
 * shutdown-time repair-commit failure the request itself never knew about (a
 * one-shot repair that completed with no divergence returns SUCCESS
 * immediately; the actual commit is deferred to daemon teardown, which
 * `cleanupDaemonAfterRequest` triggers and inspects). A caught-and-rethrown
 * error (rather than a `return` inside `finally`, which oxlint's
 * `no-unsafe-finally` rejects and which would also make a thrown `send`
 * failure silently swallowed by a later `return`) keeps cleanup running
 * unconditionally while a thrown failure still propagates normally afterward.
 */
async function performDaemonRequestWithCleanup(
  req: Omit<DaemonRequest, 'token'>,
  daemon: EnsuredDaemon,
  settings: DaemonClientSettings,
  send: () => Promise<DaemonResponse>,
): Promise<DaemonResponse> {
  let response: DaemonResponse | undefined;
  let requestFailed = false;
  let requestError: unknown;
  try {
    response = await send();
  } catch (error) {
    requestFailed = true;
    requestError = error;
  }
  const finalResponse = await cleanupDaemonAfterRequest(req, daemon, settings, response);
  if (requestFailed) throw requestError;
  if (!finalResponse) {
    // Unreachable in practice: `requestFailed` is false here, so `response`
    // was successfully set above, and `cleanupDaemonAfterRequest` always
    // returns a response (unchanged or overridden) when given one.
    throw new AppError('COMMAND_FAILED', 'Daemon request produced no response after cleanup');
  }
  return finalResponse;
}

/**
 * ADR 0012 decision 6 (Fix 1): the owned ephemeral state dir this daemon was
 * started at is otherwise unaddressable by a later invocation — hint it here,
 * only when the daemon is actually being kept alive for it
 * (`settings.ownedStateDir` means `daemon.startedByClient` is also true).
 */
function withRepairSessionAddressHintIfOwned(
  response: DaemonResponse,
  settings: DaemonClientSettings,
): DaemonResponse {
  if (response.ok || !settings.ownedStateDir || !isHeldRepairDivergence(response)) {
    return response;
  }
  return attachRepairSessionAddressHint(response, settings.paths.baseDir);
}

/**
 * ADR 0016 counterpart to `withRepairSessionAddressHintIfOwned` — but unlike
 * that one, NOT gated on `settings.ownedStateDir`. An owned ephemeral state
 * dir is unaddressable by a later invocation either way, so it's included
 * when owned; an explicit `--state-dir`/`AGENT_DEVICE_STATE_DIR` caller
 * already knows their own dir, so it's omitted then. But the session's own
 * name is cwd-qualified and, per #1394, `session list` cannot rediscover it
 * either — so `--session` is still worth hinting even at an explicit state
 * dir, which is why this runs for every active-session response regardless
 * of `ownedStateDir` (`attachActiveSessionAddressHint` itself decides what,
 * if anything, is worth attaching).
 */
function withActiveSessionAddressHint(
  response: DaemonResponse,
  req: Omit<DaemonRequest, 'token'>,
  settings: DaemonClientSettings,
): DaemonResponse {
  if (!response.ok || !isActiveReplaySessionResponse(req, response)) {
    return response;
  }
  return attachActiveSessionAddressHint(
    response,
    settings.ownedStateDir ? settings.paths.baseDir : undefined,
  );
}

function writeInstallInProgressNotice(command: string | undefined): void {
  if (!isInstallLikeCommand(command) || process.stderr.isTTY !== true || process.env.CI) return;
  process.stderr.write(
    command === PUBLIC_COMMANDS.reinstall ? 'Reinstalling...\n' : 'Installing...\n',
  );
}

function isInstallLikeCommand(command: string | undefined): boolean {
  return (
    command === PUBLIC_COMMANDS.install ||
    command === PUBLIC_COMMANDS.reinstall ||
    command === INTERNAL_COMMANDS.installSource
  );
}
