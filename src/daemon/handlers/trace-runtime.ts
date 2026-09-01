import fs from 'node:fs';
import path from 'node:path';
import type { TraceCommandResult } from '@agent-device/contracts/recording';
import { SessionStore } from '../session-store.ts';
import type { DaemonRequest, DaemonResponse, SessionState } from '../types.ts';
import { recordSessionAction } from '../session-action-recorder.ts';
import { errorResponse } from '../response.ts';

export function handleTraceCommand(params: {
  req: DaemonRequest;
  sessionName: string;
  sessionStore: SessionStore;
}): DaemonResponse {
  const action = (params.req.positionals?.[0] ?? '').toLowerCase();
  if (action !== 'start' && action !== 'stop') {
    return errorResponse('INVALID_ARGS', 'trace requires start|stop');
  }
  const session = params.sessionStore.get(params.sessionName);
  if (!session) return errorResponse('SESSION_NOT_FOUND', 'No active session');
  return action === 'start'
    ? startTrace(params.req, params.sessionStore, session)
    : stopTrace(params.req, params.sessionStore, session);
}

function startTrace(
  req: DaemonRequest,
  sessionStore: SessionStore,
  session: SessionState,
): DaemonResponse {
  if (session.trace) return errorResponse('INVALID_ARGS', 'trace already in progress');
  const outPath = SessionStore.expandHome(
    req.positionals?.[1] ?? sessionStore.defaultTracePath(session),
  );
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.appendFileSync(outPath, '');
  session.trace = { outPath, startedAt: Date.now() };
  recordSessionAction(sessionStore, session, req, req.command, { action: 'start', outPath });
  return {
    ok: true,
    data: { trace: 'started', outPath } satisfies TraceCommandResult,
  };
}

function stopTrace(
  req: DaemonRequest,
  sessionStore: SessionStore,
  session: SessionState,
): DaemonResponse {
  if (!session.trace) return errorResponse('INVALID_ARGS', 'no active trace');
  const outPath = relocateTraceOutput(session.trace.outPath, req.positionals?.[1]);
  session.trace = undefined;
  recordSessionAction(sessionStore, session, req, req.command, { action: 'stop', outPath });
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

function relocateTraceOutput(currentPath: string, requestedPath: string | undefined): string {
  if (!requestedPath) return currentPath;
  const resolved = SessionStore.expandHome(requestedPath);
  fs.mkdirSync(path.dirname(resolved), { recursive: true });
  if (fs.existsSync(currentPath)) fs.renameSync(currentPath, resolved);
  else fs.appendFileSync(resolved, '');
  return resolved;
}
