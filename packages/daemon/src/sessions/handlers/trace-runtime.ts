import type { HostEnvironment } from '@agent-device/kernel/source-value';
import type { DaemonResponse } from '@agent-device/kernel/contracts';
import { expandSessionPath } from '@agent-device/host-kit/session-paths';
import fs from 'node:fs';
import path from 'node:path';
import type { TraceCommandResult } from '@agent-device/contracts/recording';
import type { SessionStore } from '../../core/session-store.ts';
import type { DaemonRequest } from '../../core/daemon-request.ts';
import type { SessionRef } from '../../core/session-state.ts';
import { recordSessionAction } from '../../core/session-action-recorder.ts';
import { errorResponse } from '@agent-device/kernel/contracts';

export function handleTraceCommand(params: {
  host: HostEnvironment;
  req: DaemonRequest;
  sessionName: string;
  sessionStore: SessionStore;
}): DaemonResponse {
  const action = (params.req.positionals?.[0] ?? '').toLowerCase();
  if (action !== 'start' && action !== 'stop') {
    return errorResponse('INVALID_ARGS', 'trace requires start|stop');
  }
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
    host.cwd,
  );
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.appendFileSync(outPath, '');
  session.trace = { outPath, startedAt: Date.now() };
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
  const outPath = relocateTraceOutput(host, session.trace.outPath, req.positionals?.[1]);
  session.trace = undefined;
  recordSessionAction(sessionStore, ref, req, req.command, { action: 'stop', outPath });
  const clientOutPath = req.meta?.clientArtifactPaths?.outPath ?? outPath;
  return {
    ok: true,
    data: {
      trace: 'stopped',
      outPath,
      artifacts: [
        {
          field: 'outPath',
          artifactType: 'trace-log',
          path: outPath,
          localPath: clientOutPath,
          fileName: path.basename(clientOutPath),
        },
      ],
    } satisfies TraceCommandResult,
  };
}

function relocateTraceOutput(
  host: HostEnvironment,
  currentPath: string,
  requestedPath: string | undefined,
): string {
  if (!requestedPath) return currentPath;
  const resolved = expandSessionPath(requestedPath, host.cwd);
  fs.mkdirSync(path.dirname(resolved), { recursive: true });
  if (fs.existsSync(currentPath)) fs.renameSync(currentPath, resolved);
  else fs.appendFileSync(resolved, '');
  return resolved;
}
