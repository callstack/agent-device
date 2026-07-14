import path from 'node:path';
import fs from 'node:fs';
import { emitDiagnostic } from '../utils/diagnostics.ts';
import type { SessionRuntimeHints, SessionState } from './types.ts';
import { recordActionEntry, type RecordActionEntry } from './session-action-recorder.ts';
import { expandSessionPath, safeSessionName } from './session-paths.ts';
import { SessionScriptWriter, type SessionScriptWriteResult } from './session-script-writer.ts';
import { successText } from '../utils/success-text.ts';
import {
  appendActionEvent,
  appendSessionEvent,
  flushSessionEventLogWrites,
  readSessionEventLog,
  resolveSessionEventLogPath,
  type SessionEventLogInput,
  type SessionEventLogPage,
} from './session-event-log.ts';

/**
 * ADR 0012 decision 6, R7 (C5a): a reaped repair session leaves this bounded
 * marker so the next command on the same key gets `REPAIR_SESSION_EXPIRED` +
 * re-run guidance, never a bare `SESSION_NOT_FOUND`. Bounded by `expiresAt`
 * so an old tombstone never shadows an unrelated future session name.
 */
export type RepairSessionTombstone = {
  owner: string;
  reapedAt: number;
  expiresAt: number;
  sourcePath?: string;
  /**
   * ADR 0012 decision 6 (BLOCKER 2): set iff this tombstone marks a COMPLETE
   * transaction whose commit FAILED at teardown (no-clobber refusal, bare
   * `@ref`, or a filesystem write error) — as opposed to a transaction that
   * was merely reaped before it ever finished. Preserves the real failure
   * instead of losing it behind a generic "reaped before it was finalized"
   * expiry, so `repairExpiredIfTombstoned` can surface a distinct
   * `REPAIR_COMMIT_FAILED` with the actual cause.
   */
  commitFailure?: { code: string; message: string };
};

const REPAIR_TOMBSTONE_TTL_MS = 60 * 60_000;

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

  writeSessionLog(session: SessionState): SessionScriptWriteResult {
    const result = this.scriptWriter.write(session);
    if (result.written) {
      emitDiagnostic({
        level: 'info',
        phase: 'session_script_written',
        data: { session: session.name, path: result.path },
      });
    }
    return result;
  }

  /**
   * ADR 0012 decision 6, R7 + commit semantics (C2/C5a, BLOCKER 2/3): the
   * teardown finalize step for a session (idle-reap or daemon shutdown).
   *
   * BLOCKER 3: unlike the explicit `close --save-script` path
   * (`commitRepairBeforeClose`), teardown never runs `close`'s handler — but
   * the source plan's terminal `close` was already skipped-while-armed (Fix
   * 3), so a COMPLETE transaction's auto-commit here must record the same
   * synthetic finalize `close` first, or the auto-committed healed `.ad`
   * would be missing its own terminal `close` (not self-contained, unlike an
   * explicit close's commit).
   *
   * `writeSessionLog` commits the healed `.ad` iff the repair transaction
   * COMPLETED (auto-commit on completion, even without an explicit `close`)
   * and otherwise publishes nothing.
   *
   * BLOCKER 2: a COMPLETE transaction's commit can still FAIL here (no-clobber
   * refusal, bare-`@ref`, or a filesystem error) — that failure must not be
   * lost behind a generic "reaped before it was finalized" tombstone, since
   * daemon teardown deletes the session right after this call, discarding the
   * only in-memory record of what happened. Preserve it in a distinct
   * commit-failure tombstone instead, so the agent's next command surfaces
   * the real cause (`REPAIR_COMMIT_FAILED`) rather than a misleading expiry.
   * A repair-armed session torn down WITHOUT ever completing still leaves the
   * ordinary bounded `REPAIR_SESSION_EXPIRED` tombstone. A no-op for ordinary
   * (non-repair) sessions beyond the existing `writeSessionLog`.
   */
  finalizeRepairTeardown(session: SessionState): void {
    this.recordRepairFinalizeCloseIfCommitting(session);
    const result = this.writeSessionLog(session);
    if (session.saveScriptBoundary !== undefined && session.saveScriptCommitted !== true) {
      if (!result.written && result.error) {
        this.writeRepairTombstone(session, REPAIR_TOMBSTONE_TTL_MS, {
          code: String(result.error.code),
          message: result.error.message,
        });
      } else {
        this.writeRepairTombstone(session);
      }
    }
  }

  /**
   * BLOCKER 3: mirrors `commitRepairBeforeClose`'s finalize-`close` recording
   * (session-close.ts) for the auto-commit teardown path, which never routes
   * through `close`'s handler. Only recorded when this teardown is actually
   * about to attempt a commit (COMPLETE, not yet COMMITTED) — an aborted
   * (incomplete) transaction's write is a no-op regardless, so there is
   * nothing to make self-contained.
   */
  private recordRepairFinalizeCloseIfCommitting(session: SessionState): void {
    if (session.saveScriptBoundary === undefined) return;
    if (session.saveScriptComplete !== true) return;
    if (session.saveScriptCommitted === true) return;
    this.recordAction(session, {
      command: 'close',
      positionals: [],
      flags: {},
      result: { session: session.name, ...successText(`Closed: ${session.name}`) },
    });
  }

  /**
   * ADR 0012 decision 6, R7 (C5a, BLOCKER 2): drops a bounded tombstone for a
   * repair-armed session reaped/torn down before it committed, so a later
   * command targeting the same session key surfaces `REPAIR_SESSION_EXPIRED`
   * with a re-run hint instead of a bare `SESSION_NOT_FOUND`. When
   * `commitFailure` is supplied (a COMPLETE transaction's commit attempt
   * FAILED, rather than the transaction never completing), it is preserved on
   * the tombstone so the router can surface `REPAIR_COMMIT_FAILED` with the
   * real cause instead. Best effort — a tombstone-write failure never blocks
   * teardown.
   */
  writeRepairTombstone(
    session: SessionState,
    ttlMs = REPAIR_TOMBSTONE_TTL_MS,
    commitFailure?: { code: string; message: string },
  ): void {
    try {
      const dir = this.resolveSessionDir(session.name);
      fs.mkdirSync(dir, { recursive: true });
      const tombstone: RepairSessionTombstone = {
        owner: session.name,
        reapedAt: Date.now(),
        expiresAt: Date.now() + ttlMs,
        ...(session.repairSourcePath ? { sourcePath: session.repairSourcePath } : {}),
        ...(commitFailure ? { commitFailure } : {}),
      };
      fs.writeFileSync(this.repairTombstonePath(session.name), `${JSON.stringify(tombstone)}\n`);
    } catch (error) {
      emitDiagnostic({
        level: 'warn',
        phase: 'repair_tombstone_write_failed',
        data: {
          session: session.name,
          error: error instanceof Error ? error.message : String(error),
        },
      });
    }
  }

  /** Returns a non-expired repair tombstone for `sessionName`, or `undefined`. */
  readRepairTombstone(sessionName: string): RepairSessionTombstone | undefined {
    return readTombstoneFile(this.repairTombstonePath(sessionName));
  }

  /** ADR 0012 R7 (C5a): a fresh `replay --save-script` on this key clears the tombstone. */
  clearRepairTombstone(sessionName: string): void {
    try {
      fs.rmSync(this.repairTombstonePath(sessionName), { force: true });
    } catch {}
  }

  private repairTombstonePath(sessionName: string): string {
    return path.join(this.resolveSessionDir(sessionName), 'repair-tombstone.json');
  }

  defaultTracePath(session: SessionState): string {
    const safeName = safeSessionName(session.name);
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    return path.join(this.sessionsDir, `${safeName}-${timestamp}.trace.log`);
  }

  resolveSessionDir(sessionName: string): string {
    return path.join(this.sessionsDir, safeSessionName(sessionName));
  }

  // Daemon state dir (parent of the `sessions/` dir), matching daemonPaths.baseDir. Called via
  // sessionStore.resolveDaemonStateDir() in session-open.ts and session-close.ts.
  resolveDaemonStateDir(): string {
    return path.dirname(this.sessionsDir);
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

/** Parses/validates a tombstone file at `tombstonePath`; `undefined` if missing, malformed, or expired. */
function readTombstoneFile(tombstonePath: string): RepairSessionTombstone | undefined {
  let raw: string;
  try {
    raw = fs.readFileSync(tombstonePath, 'utf8');
  } catch {
    return undefined;
  }
  let parsed: RepairSessionTombstone;
  try {
    parsed = JSON.parse(raw) as RepairSessionTombstone;
  } catch {
    return undefined;
  }
  if (typeof parsed?.expiresAt !== 'number' || parsed.expiresAt <= Date.now()) return undefined;
  return parsed;
}

/**
 * ADR 0012 decision 6 (BLOCKER 2, third follow-up): scans every session
 * subdirectory under `sessionsDir` for a non-expired repair tombstone that
 * records an UNRECOVERED commit failure (`commitFailure` set) — used by the
 * CLIENT side of the daemon boundary (`cleanupDaemonAfterRequest` in
 * `daemon-client-lifecycle.ts`), which has no live `SessionStore`/session name
 * to key off of, only the filesystem path an owned ephemeral daemon was given.
 * An owned ephemeral state dir services exactly one repair transaction at a
 * time, so the first match found is returned.
 */
export function findUnrecoveredRepairCommitFailure(sessionsDir: string):
  | {
      sessionName: string;
      tombstone: RepairSessionTombstone & {
        commitFailure: NonNullable<RepairSessionTombstone['commitFailure']>;
      };
    }
  | undefined {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(sessionsDir, { withFileTypes: true });
  } catch {
    return undefined;
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const tombstone = readTombstoneFile(
      path.join(sessionsDir, entry.name, 'repair-tombstone.json'),
    );
    if (tombstone?.commitFailure) {
      return {
        sessionName: entry.name,
        tombstone: { ...tombstone, commitFailure: tombstone.commitFailure },
      };
    }
  }
  return undefined;
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
