import fs from 'node:fs';
import path from 'node:path';
import type { DaemonRequest, DaemonResponse } from '../types.ts';
import { SessionStore } from '../session-store.ts';
import { handleRecordCommand } from './record-trace-recording.ts';
import { errorResponse } from './response.ts';
import { recordSessionAction } from './handler-utils.ts';
import type { TraceCommandResult } from '../../contracts/recording.ts';

export async function handleRecordTraceCommands(params: {
  req: DaemonRequest;
  sessionName: string;
  sessionStore: SessionStore;
  logPath?: string;
}): Promise<DaemonResponse | null> {
  const { req, sessionName, sessionStore, logPath } = params;
  const command = req.command;

  if (command === 'record') {
    return handleRecordCommand({ req, sessionName, sessionStore, logPath });
  }

  if (command === 'trace') {
    const action = (req.positionals?.[0] ?? '').toLowerCase();
    if (!['start', 'stop'].includes(action)) {
      return errorResponse('INVALID_ARGS', 'trace requires start|stop');
    }
    const session = sessionStore.get(sessionName);
    if (!session) {
      return errorResponse('SESSION_NOT_FOUND', 'No active session');
    }
    if (action === 'start') {
      if (session.trace) {
        return errorResponse('INVALID_ARGS', 'trace already in progress');
      }
      const outPath = req.positionals?.[1] ?? sessionStore.defaultTracePath(session);
      const resolvedOut = SessionStore.expandHome(outPath);
      fs.mkdirSync(path.dirname(resolvedOut), { recursive: true });
      fs.appendFileSync(resolvedOut, '');
      session.trace = { outPath: resolvedOut, startedAt: Date.now() };
      recordSessionAction(sessionStore, session, req, command, {
        action: 'start',
        outPath: resolvedOut,
      });
      return {
        ok: true,
        data: { trace: 'started', outPath: resolvedOut } satisfies TraceCommandResult,
      };
    }
    if (!session.trace) {
      return errorResponse('INVALID_ARGS', 'no active trace');
    }
    let outPath = session.trace.outPath;
    if (req.positionals?.[1]) {
      const resolvedOut = SessionStore.expandHome(req.positionals[1]);
      fs.mkdirSync(path.dirname(resolvedOut), { recursive: true });
      if (fs.existsSync(outPath)) {
        fs.renameSync(outPath, resolvedOut);
      } else {
        fs.appendFileSync(resolvedOut, '');
      }
      outPath = resolvedOut;
    }
    session.trace = undefined;
    recordSessionAction(sessionStore, session, req, command, { action: 'stop', outPath });
    return { ok: true, data: { trace: 'stopped', outPath } satisfies TraceCommandResult };
  }

  return null;
}
