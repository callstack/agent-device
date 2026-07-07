import path from 'node:path';
import fs from 'node:fs';
import { emitDiagnostic } from '../utils/diagnostics.ts';
import type { SessionRuntimeHints, SessionState } from './types.ts';
import { recordActionEntry, type RecordActionEntry } from './session-action-recorder.ts';
import { expandSessionPath, safeSessionName } from './session-paths.ts';
import { SessionScriptWriter } from './session-script-writer.ts';
import {
  appendActionEvent,
  appendSessionEvent,
  flushSessionEventLogWrites,
  readSessionEventLog,
  resolveSessionEventLogPath,
  type SessionEventLogInput,
  type SessionEventLogPage,
} from './session-event-log.ts';

export class SessionStore {
  private readonly sessions = new Map<string, SessionState>();
  private readonly runtimeHints = new Map<string, SessionRuntimeHints>();
  private readonly sessionsDir: string;
  private readonly scriptWriter: SessionScriptWriter;

  constructor(sessionsDir: string) {
    this.sessionsDir = sessionsDir;
    this.scriptWriter = new SessionScriptWriter(sessionsDir);
  }

  get(name: string): SessionState | undefined {
    return this.sessions.get(name);
  }

  set(name: string, session: SessionState): void {
    this.sessions.set(name, session);
  }

  delete(name: string): boolean {
    this.runtimeHints.delete(name);
    return this.sessions.delete(name);
  }

  values(): IterableIterator<SessionState> {
    return this.sessions.values();
  }

  toArray(): SessionState[] {
    return Array.from(this.sessions.values());
  }

  getRuntimeHints(name: string): SessionRuntimeHints | undefined {
    return this.runtimeHints.get(name);
  }

  setRuntimeHints(name: string, hints: SessionRuntimeHints): void {
    this.runtimeHints.set(name, hints);
  }

  clearRuntimeHints(name: string): boolean {
    return this.runtimeHints.delete(name);
  }

  recordAction(session: SessionState, entry: RecordActionEntry): void {
    const action = recordActionEntry(session, entry);
    if (action) {
      const sessionName = this.resolveStoredSessionName(session);
      appendActionEvent(this.resolveEventLogPath(sessionName), sessionName, action);
    }
  }

  recordEvent(sessionName: string, event: SessionEventLogInput): void {
    appendSessionEvent(this.resolveEventLogPath(sessionName), sessionName, event);
  }

  readEvents(
    sessionName: string,
    options: { cursor?: string; limit?: number | string } = {},
  ): SessionEventLogPage {
    return readSessionEventLog(this.resolveEventLogPath(sessionName), options);
  }

  async flushEvents(sessionName?: string): Promise<void> {
    await flushSessionEventLogWrites(
      sessionName ? this.resolveEventLogPath(sessionName) : undefined,
    );
  }

  writeSessionLog(session: SessionState): void {
    const result = this.scriptWriter.write(session);
    if (result.written) {
      emitDiagnostic({
        level: 'info',
        phase: 'session_script_written',
        data: { session: session.name, path: result.path },
      });
    }
  }

  defaultTracePath(session: SessionState): string {
    const safeName = safeSessionName(session.name);
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    return path.join(this.sessionsDir, `${safeName}-${timestamp}.trace.log`);
  }

  resolveSessionDir(sessionName: string): string {
    return path.join(this.sessionsDir, safeSessionName(sessionName));
  }

  ensureSessionDir(sessionName: string): string {
    const sessionDir = this.resolveSessionDir(sessionName);
    fs.mkdirSync(sessionDir, { recursive: true });
    return sessionDir;
  }

  /** Path to session-scoped app log file. Agent can grep this for token-efficient debugging. */
  resolveAppLogPath(sessionName: string): string {
    return path.join(this.resolveSessionDir(sessionName), 'app.log');
  }

  resolveAppLogPidPath(sessionName: string): string {
    return path.join(this.resolveSessionDir(sessionName), 'app-log.pid');
  }

  resolveEventLogPath(sessionName: string): string {
    return resolveSessionEventLogPath(this.resolveSessionDir(sessionName));
  }

  static expandHome(filePath: string, cwd?: string): string {
    return expandSessionPath(filePath, cwd);
  }

  private resolveStoredSessionName(session: SessionState): string {
    for (const [name, value] of this.sessions) {
      if (value === session) return name;
    }
    return session.name;
  }
}

/** Path to session-scoped platform subprocess output, such as Apple runner xcodebuild logs. */
export function resolveSessionRunnerLogPath(sessionDir: string): string {
  return path.join(sessionDir, 'runner.log');
}

/** Path to request-scoped daemon diagnostics for this session. */
export function resolveSessionRequestLogPath(
  sessionDir: string,
  requestId: string | undefined,
): string {
  const safeRequestId = safeSessionName(requestId && requestId.length > 0 ? requestId : 'unknown');
  return path.join(sessionDir, 'requests', `${safeRequestId}.ndjson`);
}
