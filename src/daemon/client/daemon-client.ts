import type {
  DaemonRequest as SharedDaemonRequest,
  DaemonResponse as SharedDaemonResponse,
} from '../types.ts';
import type { RequestProgressSink } from '../request-progress.ts';
import { createRequestId, emitDiagnostic, withDiagnosticTimer } from '../../utils/diagnostics.ts';
import { INTERNAL_COMMANDS, PUBLIC_COMMANDS } from '../../command-catalog.ts';
import { parseWaitPositionals } from '../../core/wait-positionals.ts';
import { prepareRemoteRequestArtifacts } from '../../remote/daemon-artifacts.ts';
import {
  cleanupDaemonAfterRequest,
  ensureDaemon,
  resolveClientSettings,
} from './daemon-client-lifecycle.ts';
import { sendRequest } from './daemon-client-transport.ts';
import {
  DAEMON_REQUEST_TIMEOUT_MS,
  INSTALL_REQUEST_TIMEOUT_MS,
  PREPARE_REQUEST_TIMEOUT_MS,
} from '../request-timeouts.ts';

export { computeDaemonCodeSignature } from '../code-signature.ts';
export { downloadRemoteArtifact } from '../../remote/daemon-artifacts.ts';
export {
  cleanupFailedDaemonStartupMetadata,
  resolveDaemonStartupHint,
} from './daemon-client-metadata.ts';
export { canConnectSocket } from './daemon-client-transport.ts';
export { shouldResetDaemonAfterRequestTimeout } from './daemon-client-timeout.ts';
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
  try {
    return await withDiagnosticTimer(
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
  } finally {
    await cleanupDaemonAfterRequest(req, daemon, settings);
  }
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

export function resolveDaemonRequestTimeoutMs(
  req: Omit<DaemonRequest, 'token'>,
): number | undefined {
  if (req.command === PUBLIC_COMMANDS.test) return undefined;
  if (req.command === PUBLIC_COMMANDS.wait) {
    // The wait budget travels as a positional, not a flag, so parse it the same
    // way the daemon will. Without this, a `wait ... 180000` dies at the default
    // request timeout with the runner/daemon torn down as collateral.
    const waitBudgetMs = resolveWaitRequestBudgetMs(req.positionals);
    if (waitBudgetMs !== null) {
      return Math.max(DAEMON_REQUEST_TIMEOUT_MS, waitBudgetMs + WAIT_REQUEST_TIMEOUT_MARGIN_MS);
    }
  }
  if (typeof req.flags?.timeoutMs === 'number' && isExplicitTimeoutCommand(req.command)) {
    return req.flags.timeoutMs;
  }
  if (req.command === PUBLIC_COMMANDS.prepare) return PREPARE_REQUEST_TIMEOUT_MS;
  if (isInstallLikeCommand(req.command)) return INSTALL_REQUEST_TIMEOUT_MS;
  return DAEMON_REQUEST_TIMEOUT_MS;
}

function isExplicitTimeoutCommand(command: string | undefined): boolean {
  return (
    command === PUBLIC_COMMANDS.prepare ||
    command === PUBLIC_COMMANDS.replay ||
    command === PUBLIC_COMMANDS.snapshot
  );
}

// Margin over the user-supplied wait budget so the daemon-side timeout result
// (with its stable/wait diagnostics) wins the race against the client envelope.
const WAIT_REQUEST_TIMEOUT_MARGIN_MS = 30_000;

function resolveWaitRequestBudgetMs(positionals: string[] | undefined): number | null {
  const parsed = parseWaitPositionals(positionals ?? []);
  if (!parsed) return null;
  if (parsed.kind === 'sleep') return parsed.durationMs;
  return parsed.timeoutMs;
}
