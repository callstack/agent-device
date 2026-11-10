import type { HostEnvironment } from '@agent-device/kernel/source-value';
import type { DaemonResponse } from '@agent-device/kernel/contracts';
import { expandSessionPath } from '@agent-device/host-kit/session-paths';
import fs from 'node:fs';
import path from 'node:path';
import {
  parseTraceAction,
  TRACE_ACTION_REQUIRED_MESSAGE,
  type TraceCommandResult,
} from '@agent-device/contracts/recording';
import type { SessionStore } from '../../core/session-store.ts';
import { requestCwd, type DaemonRequest } from '../../core/daemon-request.ts';
import type { SessionRef } from '../../core/session-state.ts';
import { recordSessionAction } from '../../core/session-action-recorder.ts';
import { errorResponse } from '@agent-device/kernel/contracts';
import { withCaptureOutputOwnership } from '../../core/capture-output-ownership.ts';

export function handleTraceCommand(params: {
  host: HostEnvironment;
  req: DaemonRequest;
  sessionName: string;
  sessionStore: SessionStore;
}): DaemonResponse {
  const action = parseTraceAction(params.req.positionals);
  if (!action) return errorResponse('INVALID_ARGS', TRACE_ACTION_REQUIRED_MESSAGE);
  const ref = params.sessionStore.lookup(params.sessionName);
  if (!ref) return errorResponse('SESSION_NOT_FOUND', 'No active session');
  return action === 'start'
    ? startTrace(params.host, params.req, params.sessionStore, ref)
    : stopTrace(params.host, params.req, params.sessionStore, ref);
}

function startTrace(
  host: HostEnvironment,
  req: DaemonRequest,
  sessionStore: SessionStore,
  ref: SessionRef,
): DaemonResponse {
  const session = sessionStore.requireCurrent(ref);
  if (session.trace) return errorResponse('INVALID_ARGS', 'trace already in progress');
  const outPath = expandSessionPath(
    req.positionals?.[1] ?? sessionStore.defaultTracePath(session),
    requestCwd(req, host),
  );
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.appendFileSync(outPath, '');
  session.trace = {
    outPath,
    startedAt: Date.now(),
    clientOutPath: req.meta?.clientArtifactPaths?.outPath,
    ...(req.internal?.publicNetworkOnly ? { remoteCaptureOutputPath: outPath } : {}),
    remoteCaptureTenantId: session.lease?.tenantId ?? req.meta?.tenantId,
  };
  recordSessionAction(sessionStore, ref, req, req.command, { action: 'start', outPath });
  return {
    ok: true,
    data: { trace: 'started', outPath } satisfies TraceCommandResult,
  };
}

function stopTrace(
  host: HostEnvironment,
  req: DaemonRequest,
  sessionStore: SessionStore,
  ref: SessionRef,
): DaemonResponse {
  const session = sessionStore.requireCurrent(ref);
  if (!session.trace) return errorResponse('INVALID_ARGS', 'no active trace');
  const outPath = relocateTraceOutput(
    requestCwd(req, host),
    session.trace.outPath,
    req.positionals?.[1],
  );
  const daemonOwned = session.trace.remoteCaptureOutputPath === outPath;
  const tenantId = session.trace.remoteCaptureTenantId;
  const clientOutPath =
    req.meta?.clientArtifactPaths?.outPath ??
    session.trace.clientOutPath ??
    (req.internal?.publicNetworkOnly ? undefined : outPath);
  session.trace = undefined;
  recordSessionAction(sessionStore, ref, req, req.command, { action: 'stop', outPath });
  return {
    ok: true,
    data: withCaptureOutputOwnership(
      {
        trace: 'stopped',
        outPath,
        artifacts: [
          {
            field: 'outPath',
            artifactType: 'trace-log',
            path: outPath,
            localPath: clientOutPath,
            fileName: path.basename(clientOutPath ?? outPath),
          },
        ],
      } satisfies TraceCommandResult,
      daemonOwned ? 'daemon' : 'caller',
      tenantId,
    ),
  };
}

function relocateTraceOutput(
  cwd: string,
  currentPath: string,
  requestedPath: string | undefined,
): string {
  if (!requestedPath) return currentPath;
  const resolved = expandSessionPath(requestedPath, cwd);
  fs.mkdirSync(path.dirname(resolved), { recursive: true });
  if (fs.existsSync(currentPath)) fs.renameSync(currentPath, resolved);
  else fs.appendFileSync(resolved, '');
  return resolved;
}
