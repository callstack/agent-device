import path from 'node:path';
import fs from 'node:fs';
import { AppError } from '@agent-device/kernel/errors';
import { emitDiagnostic } from '@agent-device/host-kit/diagnostics';
import type { SessionRef, SessionRuntimeHints, SessionState } from './session-state.ts';
import { recordActionEntry, type RecordActionEntry } from './session-action-recorder.ts';
import { isSafeSessionSegment, safeSessionName } from '@agent-device/host-kit/session-paths';
import {
  resolveSessionDir,
  resolveSessionAppLogPath,
  resolveSessionAppLogPidPath,
} from './session-artifact-paths.ts';
import {
  readRepairTombstoneFile,
  clearRepairTombstoneFile,
  resolveRepairTombstonePath,
  type RepairSessionTombstone,
} from '../session-repair-tombstone.ts';
import {
  readIdleSessionTombstoneFile,
  resolveIdleSessionTombstonePath,
  type IdleSessionTombstone,
} from './session-idle-tombstone.ts';
import { NO_SCRIPT_PUBLICATION, isRepairCommittable } from './session-script-publication-state.ts';
import { effectiveWriteForce } from './session-script-publication-capability.ts';
import {
  isUncommittedRepairSession,
  repairSessionSourcePath,
} from './session-replay-transaction.ts';
import {
  SessionScriptWriter,
  type SessionScriptWriteOptions,
  type SessionScriptWriteResult,
} from './session-script-writer.ts';
import { successText } from '@agent-device/kernel/success-text';
import {
  appendActionEvent,
  appendSessionEvent,
  flushSessionEventLogWrites,
  readSessionEventLog,
  resolveSessionEventLogPath,
  type SessionEventLogInput,
  type SessionEventLogPage,
} from '@agent-device/session-journal/session-event-log';

const REPAIR_TOMBSTONE_TTL_MS = 60 * 60_000;
type SessionEntry = { current: SessionState };
type SessionPatch = Partial<SessionState> | ((current: SessionState) => Partial<SessionState>);

export class SessionStore {
  private readonly sessions = new Map<string, SessionEntry>();
  private acceptingSessions = true;
  private readonly runtimeHints = new Map<string, SessionRuntimeHints>();
  private readonly sessionsDir: string;
  private readonly scriptWriter: SessionScriptWriter;

  constructor(sessionsDir: string) {
    this.sessionsDir = sessionsDir;
    this.scriptWriter = new SessionScriptWriter(sessionsDir);
  }

  /**
   * Returns the LIVE record, not a copy: mutating a field on the result is a durable write
   * to store state whether or not {@link SessionStore.set} is called afterwards. Which
   * modules may do that is declared in `SESSION_STATE_FIELD_OWNERS`
   * (`scripts/layering/session-state.ts`) and enforced by the layering gate's R7, because
   * nothing here can check the invariant a given field carries.
   */
  get(name: string): SessionState | undefined {
    return this.sessions.get(name)?.current;
  }

  closeAdmission(): void {
    this.acceptingSessions = false;
  }

  assertAdmissionOpen(address: string): void {
    if (!this.acceptingSessions) {
      throw new AppError('COMMAND_FAILED', 'Daemon is shutting down', {
        reason: 'daemon_shutting_down',
        session: address,
      });
    }
  }

  assertPublishable(address: string): void {
    this.assertAdmissionOpen(address);
    if (this.sessions.has(address)) {
      throw new AppError('COMMAND_FAILED', 'Session address is already occupied', {
        reason: 'session_address_occupied',
        session: address,
      });
    }
  }

  publish(address: string, session: SessionState): SessionRef {
    this.assertPublishable(address);
    const entry = { current: session };
    this.sessions.set(address, entry);
    this.clearIdleExpiryTombstone(address);
    return this.captureRef(address, entry);
  }

  resolveCurrent(ref: SessionRef): SessionState | undefined {
    const entry = this.sessions.get(ref.address);
    return entry === ref.lifetime ? entry.current : undefined;
  }

  refresh(ref: SessionRef): SessionRef {
    const entry = this.sessions.get(ref.address);
    return entry === ref.lifetime ? this.captureRef(ref.address, entry) : ref;
  }

  requireCurrent(ref: SessionRef): SessionState {
    const session = this.resolveCurrent(ref);
    if (!session) {
      throw new AppError('COMMAND_FAILED', 'Session lifetime has ended', {
        reason: 'session_lifetime_ended',
        session: ref.address,
        hint: 'Open a new session before retrying the command.',
      });
    }
    return session;
  }

  /** Patch callbacks are synchronous and must not call back into the store. */
  update(ref: SessionRef, patch: SessionPatch): SessionState {
    const current = this.requireCurrent(ref);
    const entry = this.sessions.get(ref.address)!;
    const changes = typeof patch === 'function' ? patch(current) : patch;
    const next = { ...current, ...changes };
    entry.current = next;
    return next;
  }

  retire(ref: SessionRef): boolean {
    if (!this.resolveCurrent(ref)) return false;
    this.runtimeHints.delete(ref.address);
    return this.sessions.delete(ref.address);
  }

  private captureRef(address: string, entry: SessionEntry): SessionRef {
    return Object.freeze({ address, session: entry.current, lifetime: entry });
  }

  /**
   * Insert or replace a session. Calling this with a record obtained from
   * {@link SessionStore.get} is a no-op — the reference is already stored — so the call
   * documents intent rather than committing anything; a genuinely new record needs it.
   */
  set(name: string, session: SessionState): void {
    // A key with no record is a NEW occupant, and the previous occupant's idle-expiry marker must
    // stop explaining this key's absences from now on. Clearing it here rather than at `open` covers
    // every way a record arrives — `open`'s provisional record, a record-only `record` session — and
    // cannot be forgotten by a future insertion path. A replacing `open` on a live session takes the
    // other branch and keeps whatever marker that session will earn for itself.
    const entry = this.sessions.get(name);
    if (entry) entry.current = session;
    else this.publish(name, session);
  }

  delete(name: string): boolean {
    this.runtimeHints.delete(name);
    return this.sessions.delete(name);
  }

  *values(): IterableIterator<SessionState> {
    for (const entry of this.sessions.values()) yield entry.current;
  }

  toArray(): SessionState[] {
    return Array.from(this.values());
  }

  /**
   * {@link SessionStore.get}, but returning the session WITH the address it answers to. The store
   * is the only owner of that mapping, so a caller that needs both never recomputes the key or
   * falls back to `SessionState.name` (#2031/#1394).
   */
  lookup(address: string): SessionRef | undefined {
    const entry = this.sessions.get(address);
    return entry ? this.captureRef(address, entry) : undefined;
  }

  /** The session currently bound to `deviceId`, with its address, or `undefined` if none is. */
  findByDevice(deviceId: string): SessionRef | undefined {
    for (const [address, entry] of this.sessions) {
      if (entry.current.device.id === deviceId) return this.captureRef(address, entry);
    }
    return undefined;
  }

  /** Every live session with its address, for surfaces that must report what `--session` accepts. */
  listRefs(): SessionRef[] {
    return Array.from(this.sessions, ([address, entry]) => this.captureRef(address, entry));
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

  writeSessionLog(ref: SessionRef, options?: SessionScriptWriteOptions): SessionScriptWriteResult {
    const session = this.requireCurrent(ref);
    const result = this.scriptWriter.write(session, options);
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
   * (`session-lifecycle/internal/session-close-script.ts`), teardown never runs `close`'s
   * handler — but the source plan's terminal `close` was already skipped-while-armed (Fix 3),
   * so a COMPLETE transaction's auto-commit here must record the same
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
  finalizeRepairTeardown(ref: SessionRef): void {
    const session = this.resolveCurrent(ref);
    if (!session) return;
    this.recordRepairFinalizeCloseIfCommitting(session);
    // #1258: no live request here (idle-reap/daemon-shutdown teardown), so
    // the only source of `force` is whatever was persisted on the session at
    // arm time.
    const result = this.writeSessionLog(ref, {
      force: effectiveWriteForce(session, undefined),
    });
    if (isUncommittedRepairSession(session)) {
      if (!result.written && result.error) {
        this.writeRepairTombstone(ref, REPAIR_TOMBSTONE_TTL_MS, {
          code: String(result.error.code),
          message: result.error.message,
        });
      } else {
        this.writeRepairTombstone(ref);
      }
    }
  }

  /**
   * BLOCKER 3: mirrors the explicit close script's finalize-`close` recording
   * (`session-lifecycle/internal/session-close-script.ts`) for the auto-commit path, which never
   * routes through `close`'s handler. Only recorded when this teardown is actually
   * about to attempt a commit (COMPLETE, not yet COMMITTED) — an aborted
   * (incomplete) transaction's write is a no-op regardless, so there is
   * nothing to make self-contained.
   */
  private recordRepairFinalizeCloseIfCommitting(session: SessionState): void {
    const state = session.scriptPublication ?? NO_SCRIPT_PUBLICATION;
    if (!isRepairCommittable(state)) return;
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
    ref: SessionRef,
    ttlMs = REPAIR_TOMBSTONE_TTL_MS,
    commitFailure?: { code: string; message: string },
  ): void {
    const session = this.resolveCurrent(ref);
    if (!session) return;
    try {
      const dir = this.resolveSessionDir(ref.address);
      fs.mkdirSync(dir, { recursive: true });
      const tombstone: RepairSessionTombstone = {
        owner: ref.address,
        reapedAt: Date.now(),
        expiresAt: Date.now() + ttlMs,
        ...(repairSessionSourcePath(session)
          ? { sourcePath: repairSessionSourcePath(session) }
          : {}),
        ...(commitFailure ? { commitFailure } : {}),
      };
      fs.writeFileSync(this.repairTombstonePath(ref.address), `${JSON.stringify(tombstone)}\n`);
    } catch (error) {
      emitDiagnostic({
        level: 'warn',
        phase: 'repair_tombstone_write_failed',
        data: {
          session: ref.address,
          error: error instanceof Error ? error.message : String(error),
        },
      });
    }
  }

  /** Returns a non-expired repair tombstone for `sessionName`, or `undefined`. */
  readRepairTombstone(sessionName: string): RepairSessionTombstone | undefined {
    return readRepairTombstoneFile(this.repairTombstonePath(sessionName), sessionName);
  }

  /** ADR 0012 R7 (C5a): a fresh `replay --save-script` on this key clears the tombstone. */
  clearRepairTombstone(sessionName: string): void {
    clearRepairTombstoneFile(this.repairTombstonePath(sessionName), sessionName);
  }

  /**
   * #2833: records the instant a command that attaches to this session finished, which is the moving
   * signal the opt-in inactivity deadline for a claim-holding session is measured from. The store
   * owns the field, so the request path reports the event without becoming a `SessionState` writer.
   * Callers hold the session's execution lock, which is what makes one plain assignment enough.
   *
   * An unknown address is ignored rather than fatal: the common one is an `open` whose session was
   * never built, and its own `createdAt` already starts that session's deadline clock.
   */
  noteSessionActivity(address: string, atMs: number = Date.now()): void {
    const session = this.get(address);
    if (!session) return;
    session.lastActivityAtMs = atMs;
  }

  /**
   * #2833: drops the bounded marker an idle-expired session leaves, so the next command on that key
   * learns why its session is gone instead of being told to run `open`. Best effort — the expiry
   * already happened, and a marker that cannot be written must not undo it.
   */
  writeIdleExpiryTombstone(sessionName: string, tombstone: IdleSessionTombstone): void {
    try {
      fs.mkdirSync(this.resolveSessionDir(sessionName), { recursive: true });
      fs.writeFileSync(
        resolveIdleSessionTombstonePath(this.resolveSessionDir(sessionName)),
        `${JSON.stringify(tombstone)}\n`,
      );
    } catch (error) {
      emitDiagnostic({
        level: 'warn',
        phase: 'idle_expiry_tombstone_write_failed',
        data: {
          session: sessionName,
          error: error instanceof Error ? error.message : String(error),
        },
      });
    }
  }

  /**
   * #2833: the non-expired idle-expiry marker this exact session key left when it was expired, or
   * `undefined`. Total by design: a name that cannot address a session directory has no marker rather
   * than the `INVALID_ARGS` `resolveSessionDir` would raise, because this read runs on an error path
   * where a throw would replace the caller's own failure with an internal one.
   *
   * The recorded owner has to be the key being asked about, not merely a session that shares its
   * directory. A session name becomes a directory through `safeSessionName`, which is a many-to-one
   * encoding — the same one every other session artifact shares, and one no marker may quietly fork
   * from — so two distinct keys can land in one directory. Answering for either of them with the
   * other's expiry would report the wrong window and, worse, the wrong device as the one this caller
   * just lost. Absent rather than borrowed is the safe answer.
   */
  readIdleExpiryTombstone(sessionName: string): IdleSessionTombstone | undefined {
    if (!isSafeSessionSegment(sessionName)) return undefined;
    const tombstone = readIdleSessionTombstoneFile(
      resolveIdleSessionTombstonePath(this.resolveSessionDir(sessionName)),
    );
    return tombstone?.owner === sessionName ? tombstone : undefined;
  }

  /**
   * #2833: a fresh `open` on this key clears the idle-expiry marker, so a later `SESSION_NOT_FOUND`
   * for a DIFFERENT removal of this session (an explicit `close`, a lease expiry) can't borrow the
   * old expiry's explanation. Best effort, like the write.
   */
  clearIdleExpiryTombstone(sessionName: string): void {
    try {
      fs.rmSync(resolveIdleSessionTombstonePath(this.resolveSessionDir(sessionName)), {
        force: true,
      });
    } catch (error) {
      emitDiagnostic({
        level: 'warn',
        phase: 'idle_expiry_tombstone_clear_failed',
        data: {
          session: sessionName,
          error: error instanceof Error ? error.message : String(error),
        },
      });
    }
  }

  private repairTombstonePath(sessionName: string): string {
    return resolveRepairTombstonePath(this.resolveSessionDir(sessionName));
  }

  defaultTracePath(session: SessionState): string {
    const safeName = safeSessionName(session.name);
    const timestamp = new Date().toISOString().replaceAll(/[:.]/g, '-');
    return path.join(this.sessionsDir, `${safeName}-${timestamp}.trace.log`);
  }

  resolveSessionDir(sessionName: string): string {
    return resolveSessionDir(this.sessionsDir, sessionName);
  }

  // Daemon state dir (parent of the `sessions/` dir), matching daemonPaths.baseDir. Called via
  // sessionStore.resolveDaemonStateDir() in session-lifecycle/internal/session-open.ts and
  // session-lifecycle/internal/session-close.ts.
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
    return resolveSessionAppLogPath(this.sessionsDir, sessionName);
  }

  resolveAppLogPidPath(sessionName: string): string {
    return resolveSessionAppLogPidPath(this.sessionsDir, sessionName);
  }

  resolveEventLogPath(sessionName: string): string {
    return resolveSessionEventLogPath(this.resolveSessionDir(sessionName));
  }

  /**
   * Resolve the map key for a live session object. SessionState.name is the
   * public session name, while the map key may include cwd/tenant isolation.
   */
  resolveStoredSessionName(session: SessionState): string {
    for (const [name, entry] of this.sessions) {
      if (entry.current === session) return name;
    }
    return session.name;
  }
}
