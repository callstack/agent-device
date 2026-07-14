import fs from 'node:fs';
import path from 'node:path';
import { publicPlatformString } from '../kernel/device.ts';
import { inferFillText } from './action-utils.ts';
import { emitDiagnostic } from '../utils/diagnostics.ts';
import { AppError } from '../kernel/errors.ts';
import {
  formatPortableActionLine,
  formatTargetAnnotationLines,
} from '../replay/script-formatting.ts';
import { expandSessionPath, safeSessionName } from './session-paths.ts';
import {
  appendScriptSeriesFlags,
  formatScriptArg,
  formatScriptStringLiteral,
  isClickLikeCommand,
  isTouchTargetCommand,
  stripRecordedRefGeneration,
} from '../replay/script-utils.ts';
import type { SessionAction, SessionState } from './types.ts';

/**
 * `{ written: true; path }` — committed. `{ written: false }` (no `error`) —
 * intentionally not written (not recording, an aborted/incomplete repair
 * transaction, or an idempotent already-committed no-op). `{ written: false;
 * error }` — ADR 0012 decision 6 (BLOCKER 2): a repair COMMIT was attempted but
 * FAILED (no-clobber refusal, a bare-`@ref` R4 failure, or a filesystem write
 * error). The `error` (a distinct AppError code/message) is surfaced to
 * close/teardown so the failure is reportable and the session can be kept for
 * retry, never swallowed into a silent skip.
 */
export type SessionScriptWriteResult =
  | { written: true; path: string }
  | { written: false; error?: AppError };

/**
 * ADR 0012 decision 6 (Fix 4, C2): trailer comment marking a healed `.ad` as a
 * COMPLETE, review-worthy repair artifact. An ordinary `#` comment to every
 * reader (old and new) — it binds to nothing (`parseTargetAnnotationCommentLine`
 * only recognizes the `target-v1` prefix), so it never participates in the
 * target-annotation binding rule. Written only when a repair-armed session's
 * write reaches this point at all, since `write()` already gated that on the
 * transaction being COMPLETE (`saveScriptComplete`) — so every write carrying
 * it IS a complete, committed transaction.
 */
export const HEAL_COMPLETE_SENTINEL = '# agent-device:heal-complete';

/**
 * ADR 0012 decision 6, R7 + commit semantics (C2): a repair-armed session is a
 * live transaction, COMMITTED only on completion — `true` means "do not publish
 * now":
 * - Already committed -> idempotent no-op (never a duplicate/second write).
 * - Not COMPLETE (the plan never ran to its last executable step) -> ABORT:
 *   publish NOTHING. This is what stops a `close`/`close --save-script` issued
 *   after a divergence but before the plan finishes from committing a PREFIX;
 *   every non-completion teardown (divergence-only exit, daemon shutdown,
 *   idle-reap) lands here too.
 * Ordinary (non-repair) recording is never blocked (no `saveScriptBoundary`).
 */
function isRepairArmedWriteBlocked(session: SessionState): boolean {
  if (session.saveScriptBoundary === undefined) return false;
  if (session.saveScriptCommitted) return true;
  return !session.saveScriptComplete;
}

export class SessionScriptWriter {
  private readonly sessionsDir: string;

  constructor(sessionsDir: string) {
    this.sessionsDir = sessionsDir;
  }

  write(session: SessionState): SessionScriptWriteResult {
    const repairArmed = session.saveScriptBoundary !== undefined;
    let scriptPath: string | undefined;
    try {
      if (!session.recordSession) return { written: false };
      if (isRepairArmedWriteBlocked(session)) return { written: false };
      scriptPath = this.resolveScriptPath(session);
      const scriptDir = path.dirname(scriptPath);
      if (!fs.existsSync(scriptDir)) fs.mkdirSync(scriptDir, { recursive: true });
      const script = formatSessionScript(session, repairArmed);
      publishHealedScriptAtomically({
        scriptPath,
        script,
        // ADR 0012 decision 6 (BLOCKER 4): the completeness-aware no-clobber
        // guard protects EVERY repair-armed publish target — the DEFAULT
        // healed sibling AND an explicit `--save-script=<path>` alike. An
        // explicit target is still caller-DIRECTED (which path), never
        // caller-authorized to silently destroy an unreviewed prior healed
        // diff sitting there; the caller must remove/rename it or pick
        // another path. Only ever actually engages against a sentinel-marked
        // artifact, which only a repair-armed write can produce, so an
        // ordinary (non-repair) recording's target is unaffected either way.
        protectComplete: repairArmed,
      });
      // COMMITTED: idempotent guard above + teardown's abort/tombstone routing.
      if (repairArmed) session.saveScriptCommitted = true;
      return { written: true, path: scriptPath };
    } catch (error) {
      emitDiagnostic({
        level: 'warn',
        phase: 'session_script_write_failed',
        data: {
          session: session.name,
          path: scriptPath,
          error: error instanceof Error ? error.message : String(error),
        },
      });
      // ADR 0012 decision 6, R4 + BLOCKER 2: a repair COMMIT failure must be
      // SURFACED (no-clobber refusal, bare-`@ref`, or a filesystem error alike)
      // so close/teardown can report it and keep the session for retry — never
      // swallowed into a silent `{written:false}`. Ordinary (non-repair)
      // recording keeps its existing behavior: an unexpected AppError still
      // fails loud (none is raised on that path today), an fs error is a quiet
      // skip.
      if (repairArmed) {
        return { written: false, error: toRepairCommitFailure(error, scriptPath) };
      }
      if (error instanceof AppError) throw error;
      return { written: false };
    }
  }

  private resolveScriptPath(session: SessionState): string {
    if (session.saveScriptPath) {
      return expandSessionPath(session.saveScriptPath);
    }
    if (!fs.existsSync(this.sessionsDir)) fs.mkdirSync(this.sessionsDir, { recursive: true });
    const safeName = safeSessionName(session.name);
    const timestamp = new Date(session.createdAt).toISOString().replace(/[:.]/g, '-');
    return path.join(this.sessionsDir, `${safeName}-${timestamp}.ad`);
  }
}

/**
 * ADR 0012 decision 6 (BLOCKER 2c): normalizes a repair-commit failure into a
 * distinct, surfaceable AppError. A no-clobber refusal or a bare-`@ref` failure
 * arrives as an AppError already (with its own message) and passes through
 * unchanged; anything else is a filesystem write failure, wrapped with a clear
 * message and hint so the two are distinguishable to the agent.
 */
function toRepairCommitFailure(error: unknown, scriptPath: string | undefined): AppError {
  if (error instanceof AppError) return error;
  const detail = error instanceof Error ? error.message : String(error);
  return new AppError(
    'COMMAND_FAILED',
    `Failed to write the healed script${scriptPath ? ` to ${scriptPath}` : ''}: ${detail}`,
    {
      hint: 'The repair transaction completed but the healed .ad could not be published; check the target path and permissions, then retry close --save-script.',
    },
  );
}

function formatSessionScript(session: SessionState, appendCompleteSentinel: boolean): string {
  return formatScript(session, buildOptimizedActions(session), appendCompleteSentinel);
}

/**
 * ADR 0012 decision 6, commit semantics + no-clobber (Fix 4, C5b, BLOCKER 1):
 * publishes `script` to `scriptPath` atomically AND race-safely.
 *
 * - Atomic: the temp file is created in the SAME DIRECTORY as the target
 *   (never `/tmp`), so the final publish is an intra-directory rename/link on
 *   one filesystem — a reader never observes a half-written script, and an
 *   explicit `--save-script=<path>` on a different mount still publishes
 *   atomically. An aborted write leaves only the (removed) temp, no partial
 *   at the target.
 * - Race-safe no-clobber (BLOCKER 1): the DEFAULT healed-sibling path is
 *   protected by `publishNoClobberAtomically`, which makes an atomic primitive
 *   (never a check-then-write gap) decide the winner even when the existing
 *   target is a partial. An explicit `--save-script=<path>` target is
 *   caller-directed and unprotected either way (`publishOverwriteAtomically`).
 */
function publishHealedScriptAtomically(params: {
  scriptPath: string;
  script: string;
  protectComplete: boolean;
}): void {
  const { scriptPath, script, protectComplete } = params;
  const dir = path.dirname(scriptPath);
  const tempPath = path.join(
    dir,
    `.${path.basename(scriptPath)}.${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.tmp`,
  );
  fs.writeFileSync(tempPath, script);
  try {
    if (protectComplete) {
      publishNoClobberAtomically(tempPath, scriptPath);
    } else {
      publishOverwriteAtomically(tempPath, scriptPath);
    }
  } finally {
    // linkSync leaves the temp hard-link behind on success; rename consumes it;
    // an error leaves it — always clean up whatever of our own temp remains.
    fs.rmSync(tempPath, { force: true });
  }
}

/**
 * ADR 0012 decision 6 (BLOCKER 4): an ORDINARY (non-repair-armed) recording's
 * target is never no-clobber-protected — it never carries the completeness
 * sentinel in the first place (only a repair-armed write appends it), so
 * BLOCKER 1's "is the existing target incomplete" classification would never
 * find anything to refuse on anyway. A plain atomic publish is correct:
 * absent -> exclusive create; present -> atomic rename-replace.
 */
function publishOverwriteAtomically(tempPath: string, scriptPath: string): void {
  try {
    // Atomic create-if-absent: EEXIST iff the target already exists.
    fs.linkSync(tempPath, scriptPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    fs.renameSync(tempPath, scriptPath);
  }
}

const NO_CLOBBER_PUBLISH_MAX_ATTEMPTS = 16;
const LEASE_ACQUIRE_MAX_ATTEMPTS = 40;
const LEASE_ACQUIRE_BACKOFF_MS = 5;
/**
 * ADR 0012 decision 6 (BLOCKER 1, lease replacement, maintainer-approved
 * design): a holder older than this is treated as crashed/hung, never merely
 * slow — the publish lease's whole decide-and-act sequence is a handful of
 * synchronous fs calls, nowhere close to this budget.
 */
const LEASE_TTL_MS = 30_000;

/**
 * ADR 0012 decision 6, no-clobber (BLOCKER 1, BLOCKER 4): publishes to a
 * repair-armed session's target — the DEFAULT healed sibling path OR an
 * explicit `--save-script=<path>` alike (BLOCKER 4: an explicit target is
 * caller-DIRECTED, never caller-AUTHORIZED to silently destroy an unreviewed
 * prior healed diff) — where a COMPLETE (sentinel-marked) prior artifact must
 * never be clobbered.
 *
 * A prior fix made the "is the existing target overwritable" decision itself
 * atomic (grab-to-quarantine + inspect, `grabAndDiscardPartialTarget` below)
 * instead of a plain read — but the inspect/restore/publish SEQUENCE was
 * still not exclusive: writer A could quarantine an existing COMPLETE
 * target, and — before A restored it — writer B could `linkSync` its own
 * COMPLETE artifact into the now-empty `scriptPath` and return success, only
 * for A's restore (`renameSync`, which replaces an existing destination per
 * POSIX) to silently stomp B's freshly published bytes. B would report
 * success while its bytes were gone.
 *
 * Here the ENTIRE decide-and-act sequence for a given `scriptPath` — the
 * exclusive-link attempt, the grab/inspect, and the refuse-and-restore or
 * discard-and-retry — runs while holding a verified, exclusive publish LEASE
 * (`acquireLease`/`releaseLease` below). A competing writer for the SAME
 * `scriptPath` cannot even begin its own decision until the lease holder's
 * entire sequence has finished and released it, so the "restore stomps a
 * concurrently-published winner" interleaving above is no longer reachable:
 * whichever writer holds the lease always observes (and, on refusal,
 * restores) exactly what it itself grabbed, with nothing else able to touch
 * `scriptPath` in between.
 */
function publishNoClobberAtomically(tempPath: string, scriptPath: string): void {
  const lockPath = `${scriptPath}.lock`;
  const myToken = acquireLease(lockPath);
  try {
    // Closes the pathological window where acquiring took long enough (or
    // ran up against a small enough TTL) that this lease itself expired and
    // was stolen by someone else between `acquireLease` returning and here —
    // never publish on a lease this caller no longer verifiably holds.
    if (!verifyOwnership(lockPath, myToken)) {
      throw new AppError(
        'COMMAND_FAILED',
        `Could not publish the healed script to ${scriptPath}: the publish lease expired before the write could start.`,
      );
    }
    for (let attempt = 0; attempt < NO_CLOBBER_PUBLISH_MAX_ATTEMPTS; attempt += 1) {
      if (tryExclusiveLink(tempPath, scriptPath)) return;
      // Something is at `scriptPath`. We hold the verified exclusive publish
      // lease, so nothing else can repopulate it underneath us: this is
      // either a genuine partial (grabbed-and-discarded, then retried above)
      // or a COMPLETE artifact (grabbed, restored, and the publish refused —
      // `grabAndDiscardPartialTarget` never returns on that path).
      grabAndDiscardPartialTarget(scriptPath);
    }
    throw new AppError(
      'COMMAND_FAILED',
      `Could not publish the healed script to ${scriptPath}: too much contention from concurrent writers.`,
    );
  } finally {
    releaseLease(lockPath, myToken);
  }
}

/**
 * ADR 0012 decision 6 (BLOCKER 1, lease replacement — maintainer-approved
 * design): claims a TTL LEASE on `lockPath` — replaces the prior PID-liveness
 * "reclaim" scheme (`reclaimDeadLock`, removed), which was structurally
 * race-prone: reclaiming a dead lock meant GRABBING it away first (rename to
 * inspect) and, if it turned out to have gone LIVE in the meantime (raced by
 * a concurrent reclaimer), RESTORING it. That grab-then-restore shape is
 * exactly the bug the reviewer found: a three-writer interleaving lets waiter
 * A rename waiter B's now-LIVE lock away (to inspect it), waiter C
 * `linkSync` its own lock into the momentarily-empty path, then A's
 * "restore" (`renameSync`, which replaces an existing destination) silently
 * clobbers C's freshly acquired lock — and a pathname-based release could
 * then remove a SUCCESSOR's lock, not the caller's own.
 *
 * A lease never has that shape — there is no restore path, ever. Each lock
 * file's content is a unique OWNER TOKEN (`pid:random:createdAtMs`).
 * Staleness is judged purely from the trailing timestamp (`LEASE_TTL_MS`),
 * never from asking the OS whether a PID is alive, so there is nothing to
 * "put back" if the judgment turns out to be wrong: a lease found to be
 * fresh is simply left completely untouched (back off, retry later); a lease
 * found to be expired is stolen via a single atomic
 * `renameSync(lockPath, <lockPath>.expired.<unique>)` — exactly one caller
 * can ever win that rename for a given still-existing `lockPath` (a second,
 * concurrent rename of the same already-moved source fails `ENOENT`, never
 * silently succeeds), so it doubles as a compare-and-swap on "the right to
 * discard whatever currently sits here". The winner discards what it grabbed
 * and retries the link; a loser (`ENOENT`) does nothing and also retries the
 * link, observing whatever the winner left behind. A LIVE holder's canonical
 * claim at `lockPath` is thus NEVER renamed or removed by anyone but its own
 * `releaseLease`.
 */
function acquireLease(lockPath: string): string {
  const myToken = createLeaseToken();
  for (let attempt = 0; attempt < LEASE_ACQUIRE_MAX_ATTEMPTS; attempt += 1) {
    if (tryClaimLease(lockPath, myToken)) return myToken;
    const existingToken = readLeaseToken(lockPath);
    // Raced away between our EEXIST and this read (the holder released, or a
    // steal completed) — nothing to judge; retry the link immediately.
    if (existingToken === undefined) continue;
    const createdAtMs = leaseCreatedAtMs(existingToken);
    if (createdAtMs === undefined || Date.now() - createdAtMs > LEASE_TTL_MS) {
      // Expired (or unparseable, which we also treat as abandoned) — steal
      // it. Whether WE won the steal or someone else did, the lock is now
      // either empty or held by a fresh claimant: retry the link either way.
      stealExpiredLease(lockPath);
      continue;
    }
    // A fresh claim — a genuinely live holder. Never touched; just wait.
    sleepSyncMs(LEASE_ACQUIRE_BACKOFF_MS);
  }
  throw new AppError(
    'COMMAND_FAILED',
    `Could not publish the healed script: timed out waiting for a concurrent writer.`,
  );
}

/** A unique per-attempt owner token: `pid:random:createdAtMs`. */
function createLeaseToken(): string {
  return `${process.pid}:${Math.random().toString(36).slice(2)}:${Date.now()}`;
}

/** Parses the trailing `createdAtMs` segment off a lease token; `undefined` if malformed. */
function leaseCreatedAtMs(token: string): number | undefined {
  const raw = token.split(':').at(-1);
  const parsed = raw === undefined ? Number.NaN : Number(raw);
  return Number.isFinite(parsed) ? parsed : undefined;
}

/**
 * The only primitive that can WIN a lease outright: atomic create-if-absent
 * via `linkSync`. `true` = claimed; `false` = `EEXIST` (something is at
 * `lockPath` right now, live or expired — the caller decides which next).
 */
function tryClaimLease(lockPath: string, token: string): boolean {
  const tempPath = `${lockPath}.${token.replace(/:/g, '-')}.tmp`;
  fs.writeFileSync(tempPath, token);
  try {
    fs.linkSync(tempPath, lockPath);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') return false;
    throw error;
  } finally {
    fs.rmSync(tempPath, { force: true });
  }
}

/** Reads the current owner token at `lockPath`; `undefined` if missing/unreadable. */
function readLeaseToken(lockPath: string): string | undefined {
  try {
    return fs.readFileSync(lockPath, 'utf8');
  } catch {
    return undefined;
  }
}

/**
 * Steals an EXPIRED lease via a single atomic rename — never a restore. On
 * success, the caller is the SOLE owner of the quarantined file (no one else
 * can have grabbed the same source path) and discards it. On `ENOENT`,
 * someone else's steal of this exact lease already won the race; there is
 * nothing left to discard. Either way, the (now-live-or-empty) `lockPath` is
 * left for the caller's next `tryClaimLease` retry to observe.
 */
function stealExpiredLease(lockPath: string): void {
  const quarantinePath = `${lockPath}.expired.${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  try {
    fs.renameSync(lockPath, quarantinePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw error;
  }
  fs.rmSync(quarantinePath, { force: true });
}

/** `true` iff `token` is still the current owner of `lockPath` right now. */
function verifyOwnership(lockPath: string, token: string): boolean {
  return readLeaseToken(lockPath) === token;
}

/**
 * Releases `lockPath` iff its CURRENT token is still `myToken` — a successor
 * that has since stolen (expired) or freshly re-claimed the same path is
 * NEVER removed by an earlier holder's release; only the caller's own claim
 * is ever a release candidate. Best-effort: a concurrent removal (already
 * gone) is not an error.
 */
function releaseLease(lockPath: string, myToken: string): void {
  if (readLeaseToken(lockPath) !== myToken) return;
  try {
    fs.unlinkSync(lockPath);
  } catch {}
}

/**
 * Blocks the event loop for `ms` — a synchronous backoff to match this
 * file's synchronous (`Sync`) publish primitives. Never runs longer than
 * `LOCK_ACQUIRE_MAX_ATTEMPTS * LOCK_ACQUIRE_BACKOFF_MS` in the worst case.
 */
function sleepSyncMs(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * The only primitive that can WIN outright: atomic create-if-absent.
 * `true` = published (won); `false` = `EEXIST` (a file is at `scriptPath`
 * right now). Any other error propagates.
 */
function tryExclusiveLink(tempPath: string, scriptPath: string): boolean {
  try {
    fs.linkSync(tempPath, scriptPath);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') return false;
    throw error;
  }
}

/**
 * Atomically grabs whatever currently sits at `scriptPath` into a private,
 * uniquely-named quarantine file (a single `renameSync`) and inspects it
 * there. The caller holds the exclusive publish lock for the whole of this
 * decision, so no OTHER writer can be repopulating `scriptPath` while we
 * inspect our quarantined copy. A genuinely partial grab is discarded
 * (returns normally — the caller retries the exclusive link). `ENOENT` is
 * unreachable under the lock but is handled defensively rather than assumed.
 * A COMPLETE grab is restored and this throws, refusing the clobber.
 */
function grabAndDiscardPartialTarget(scriptPath: string): void {
  const quarantinePath = `${scriptPath}.${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.quarantine`;
  try {
    fs.renameSync(scriptPath, quarantinePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw error;
  }
  try {
    if (isCompleteHealedScript(quarantinePath)) refuseCompleteClobber(quarantinePath, scriptPath);
  } finally {
    fs.rmSync(quarantinePath, { force: true });
  }
}

/**
 * Restores a quarantined COMPLETE artifact and refuses the publish. The
 * caller holds the exclusive publish lock, so nothing else can have
 * repopulated `scriptPath` in the meantime — the restore always lands back
 * on the same empty slot we just vacated, never over another writer's
 * publish.
 */
function refuseCompleteClobber(quarantinePath: string, scriptPath: string): never {
  fs.renameSync(quarantinePath, scriptPath);
  throw new AppError(
    'COMMAND_FAILED',
    `A prior healed script already exists at ${scriptPath}; pass replay --save-script=<path> to write elsewhere, or remove/rename it first, so an unreviewed healed script is never clobbered.`,
  );
}

function buildOptimizedActions(session: SessionState): SessionAction[] {
  // ADR 0012 decision 6, R6: a repair-armed session (`saveScriptBoundary` set
  // by `replay --save-script`) serializes only the actions from that
  // watermark onward — the repair run's own execution path — never the
  // whole session history. Absent a boundary (ordinary `open`/`close
  // --save-script`), this slices from 0: unchanged, full-history behavior.
  const repairArmed = session.saveScriptBoundary !== undefined;
  const relevantActions = session.actions.slice(session.saveScriptBoundary ?? 0);
  const optimized: SessionAction[] = [];
  for (const action of relevantActions) {
    if (action.command === 'snapshot') continue;
    const optimizedAction = optimizeSelectorChainAction(action);
    if (optimizedAction) {
      optimized.push(optimizedAction);
      continue;
    }
    // R4 is scoped to a repair-armed session, not the existing refLabel/
    // scoped-snapshot fallback ordinary `open`/`close --save-script` keeps.
    if (repairArmed) assertNoUnresolvedRefFallback(action);
    const scopedSnapshot = buildScopedSnapshotAction(session, action);
    if (scopedSnapshot) optimized.push(scopedSnapshot);
    optimized.push(action);
  }
  return optimized;
}

/**
 * ADR 0012 decision 6, R4: a selector-targeting action whose ref never
 * resolved to a `selectorChain` would otherwise fall through to a bare
 * `@ref` line here — meaningless outside the session that minted it, since a
 * fresh replay session mints its own refs. Refuse loudly instead of writing
 * an unreplayable script (see `write()`'s catch, which rethrows this rather
 * than swallowing it like an ordinary fs failure).
 */
function assertNoUnresolvedRefFallback(action: SessionAction): void {
  if (!isSelectorTargetingCommand(action.command)) return;
  const refPositional =
    action.command === 'get' ? action.positionals?.[1] : action.positionals?.[0];
  if (!refPositional?.startsWith('@')) return;
  throw new AppError(
    'COMMAND_FAILED',
    `Cannot write recorded step "${action.command} ${refPositional}" to a script: it never resolved to a selector, so the ref would not resolve in a fresh replay session.`,
  );
}

/**
 * ADR 0012 decision 6, no-clobber (Fix 4, C5b): a file is a COMPLETE,
 * review-worthy healed artifact iff it carries the completeness sentinel
 * (written only on a successful atomic commit). A file without it is a partial
 * — from an aborted/reaped repair — and is freely overwritable by a fresh
 * repair that completes.
 */
function isCompleteHealedScript(scriptPath: string): boolean {
  let contents: string;
  try {
    contents = fs.readFileSync(scriptPath, 'utf8');
  } catch {
    // Missing (nothing to clobber) or unreadable (not provably complete
    // either way — never block the repair behind a file we cannot inspect).
    return false;
  }
  return contents.split(/\r?\n/).some((line) => line.trim() === HEAL_COMPLETE_SENTINEL);
}

function optimizeSelectorChainAction(action: SessionAction): SessionAction | undefined {
  const selectorExpr = readSelectorChainExpression(action);
  if (!selectorExpr || !isSelectorTargetingCommand(action.command)) return undefined;
  if (isClickLikeCommand(action.command)) return { ...action, positionals: [selectorExpr] };
  if (action.command === 'longpress') return optimizeLongPressAction(action, selectorExpr);
  if (action.command === 'fill') return optimizeFillAction(action, selectorExpr);
  return optimizeGetAction(action, selectorExpr);
}

function readSelectorChainExpression(action: SessionAction): string | undefined {
  const selectorChain =
    Array.isArray(action.result?.selectorChain) &&
    action.result.selectorChain.every((entry) => typeof entry === 'string')
      ? (action.result.selectorChain as string[])
      : [];
  return selectorChain.length > 0 ? selectorChain.join(' || ') : undefined;
}

function isSelectorTargetingCommand(command: string): boolean {
  return isTouchTargetCommand(command) || command === 'fill' || command === 'get';
}

function optimizeFillAction(
  action: SessionAction,
  selectorExpr: string,
): SessionAction | undefined {
  const text = inferFillText(action);
  return text.length > 0 ? { ...action, positionals: [selectorExpr, text] } : undefined;
}

function optimizeLongPressAction(action: SessionAction, selectorExpr: string): SessionAction {
  const durationMs =
    typeof action.result?.durationMs === 'number'
      ? String(action.result.durationMs)
      : readLongPressDurationFromPositionals(action.positionals ?? []);
  return {
    ...action,
    positionals: durationMs ? [selectorExpr, durationMs] : [selectorExpr],
  };
}

function optimizeGetAction(action: SessionAction, selectorExpr: string): SessionAction | undefined {
  const sub = action.positionals?.[0];
  return sub === 'text' || sub === 'attrs'
    ? { ...action, positionals: [sub, selectorExpr] }
    : undefined;
}

function readLongPressDurationFromPositionals(positionals: string[]): string | undefined {
  const last = positionals.at(-1);
  if (positionals.length <= 1 || last === undefined || last.trim() === '') return undefined;
  return Number.isFinite(Number(last)) ? last : undefined;
}

function buildScopedSnapshotAction(
  session: SessionState,
  action: SessionAction,
): SessionAction | undefined {
  if (!isSelectorTargetingCommand(action.command)) return undefined;
  const refLabel = action.result?.refLabel;
  if (typeof refLabel !== 'string' || refLabel.trim().length === 0) return undefined;
  const scope = refLabel.trim();
  return {
    ts: action.ts,
    command: 'snapshot',
    positionals: [],
    flags: {
      platform: session.device.platform,
      snapshotInteractiveOnly: true,
      snapshotScope: scope,
    },
    result: { scope },
  };
}

function formatScript(
  session: SessionState,
  actions: SessionAction[],
  appendCompleteSentinel: boolean,
): string {
  const lines: string[] = [];
  const kind = session.device.kind ? ` kind=${session.device.kind}` : '';
  const theme = 'unknown';
  lines.push(
    // approach (b): emit the PUBLIC leaf platform (ios/macos), never the internal `apple`.
    `context platform=${publicPlatformString(session.device)} device=${formatScriptStringLiteral(session.device.name)}${kind} theme=${theme}`,
  );
  for (const action of actions) {
    if (action.flags?.noRecord) continue;
    lines.push(...formatTargetAnnotationLines(action));
    lines.push(formatActionLine(action));
  }
  // ADR 0012 decision 6 (Fix 4): only a repair-armed session's healed script
  // carries the completeness sentinel — `write()` already refused to reach
  // here unless it was finalized, so every repair-armed write IS complete.
  if (appendCompleteSentinel) lines.push(HEAL_COMPLETE_SENTINEL);
  return `${lines.join('\n')}\n`;
}

function formatActionLine(action: SessionAction): string {
  const parts: string[] = [action.command];
  const specialLine = formatSpecialActionLine(parts, action);
  if (specialLine) return specialLine;
  return formatPortableActionLine(action);
}

function formatSpecialActionLine(parts: string[], action: SessionAction): string | undefined {
  if (isClickLikeCommand(action.command)) {
    return formatClickLikeActionLine(parts, action);
  }
  if (action.command === 'fill') {
    return formatFillActionLine(parts, action);
  }
  if (action.command === 'get') {
    return formatGetActionLine(parts, action);
  }
  return undefined;
}

function formatClickLikeActionLine(parts: string[], action: SessionAction): string | undefined {
  const first = action.positionals?.[0];
  if (!first) return undefined;
  if (first.startsWith('@')) {
    // Recorded refs may carry a `~s<generation>` pin (#1076); scripts store the
    // plain ref — generations are meaningless outside the minting session.
    parts.push(formatScriptArg(stripRecordedRefGeneration(first)));
    appendRefLabel(parts, action);
    appendScriptSeriesFlags(parts, action);
    return parts.join(' ');
  }
  if (action.positionals.length === 1) {
    parts.push(formatScriptArg(first));
    appendScriptSeriesFlags(parts, action);
    return parts.join(' ');
  }
  return undefined;
}

function formatFillActionLine(parts: string[], action: SessionAction): string | undefined {
  const ref = action.positionals?.[0];
  if (!ref?.startsWith('@')) return undefined;
  parts.push(formatScriptArg(stripRecordedRefGeneration(ref)));
  appendRefLabel(parts, action);
  const text = action.positionals.slice(1).join(' ');
  // Preserve explicit empty-string fill arguments.
  if (action.positionals.length > 1) {
    parts.push(formatScriptArg(text));
  }
  appendScriptSeriesFlags(parts, action);
  return parts.join(' ');
}

function formatGetActionLine(parts: string[], action: SessionAction): string | undefined {
  const sub = action.positionals?.[0];
  const ref = action.positionals?.[1];
  if (!sub || !ref) return undefined;
  parts.push(formatScriptArg(sub));
  parts.push(formatScriptArg(stripRecordedRefGeneration(ref)));
  if (ref.startsWith('@')) appendRefLabel(parts, action);
  return parts.join(' ');
}

function appendRefLabel(parts: string[], action: SessionAction): void {
  const refLabel = action.result?.refLabel;
  if (typeof refLabel === 'string' && refLabel.trim().length > 0) {
    parts.push(formatScriptArg(refLabel));
  }
}
