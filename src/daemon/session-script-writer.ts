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
        // The completeness-aware no-clobber guard protects ONLY the DEFAULT
        // healed sibling (an explicit `--save-script=<out>` may overwrite as
        // the caller directed).
        protectComplete: Boolean(session.saveScriptDefaultedHealedPath),
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
 * An explicit `--save-script=<path>` target is caller-directed and never
 * no-clobber-protected — BLOCKER 1's "is the existing target incomplete"
 * classification never runs on this path, so a plain atomic publish is
 * correct: absent -> exclusive create; present -> atomic rename-replace.
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

/**
 * ADR 0012 decision 6, no-clobber (BLOCKER 1): publishes to the DEFAULT healed
 * sibling path, where a COMPLETE (sentinel-marked) prior artifact must never
 * be clobbered.
 *
 * The prior implementation decided "is the existing target overwritable" with
 * a plain read (`isCompleteHealedScript`) followed later by an unconditional
 * `renameSync`. Two concurrent writers could both read the SAME pre-existing
 * partial as incomplete and then both `renameSync` over it — each returning
 * success with no signal to the other. Neither writer ever observed the
 * loss: a silent, undetectable clobber.
 *
 * Here every step that could decide a winner is an atomic filesystem
 * primitive, never a check-then-write gap:
 * - `linkSync` is the ONLY way to WIN outright: it fails atomically (`EEXIST`)
 *   iff a file is at `scriptPath` at that exact instant.
 * - On `EEXIST`, the existing file is inspected on a PRIVATE copy, never the
 *   shared path: `renameSync` atomically moves whatever currently sits at
 *   `scriptPath` into a uniquely-named quarantine file first, so the
 *   completeness check runs on a copy nobody else can race against. If a
 *   competing writer's own grab (or publish) already claimed `scriptPath` in
 *   between, our `renameSync` fails (`ENOENT`) and we re-evaluate from the
 *   top against the current state — never a stale read.
 * - A COMPLETE quarantined file is put back (best effort) and the publish is
 *   refused; a genuinely partial one is discarded and the exclusive
 *   `linkSync` is retried.
 *
 * Every interleaving converges on exactly one winning `linkSync` and every
 * other writer observing a definitive, thrown "already exists" — never two
 * silent successes, never a torn/half-clobbered file.
 */
function publishNoClobberAtomically(tempPath: string, scriptPath: string): void {
  for (let attempt = 0; attempt < NO_CLOBBER_PUBLISH_MAX_ATTEMPTS; attempt += 1) {
    if (tryExclusiveLink(tempPath, scriptPath)) return;
    // Something is at `scriptPath`. Either it gets grabbed-and-discarded as a
    // genuine partial, or a competing writer's own grab/publish already beat
    // us to it — either way, re-evaluate from the top via the exclusive link
    // above rather than trust a stale read. Throws (never returns) if what we
    // grabbed turns out to be a COMPLETE artifact.
    grabAndDiscardPartialTarget(scriptPath);
  }
  throw new AppError(
    'COMMAND_FAILED',
    `Could not publish the healed script to ${scriptPath}: too much contention from concurrent writers.`,
  );
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
 * uniquely-named quarantine file (a single `renameSync`, so nobody else can
 * race the completeness check against it) and inspects it there. A genuinely
 * partial grab is discarded (returns normally — the caller retries the
 * exclusive link). `ENOENT` means a competing writer's own grab or publish
 * already changed `scriptPath` between our `EEXIST` and this call — also
 * returns normally, for the same "retry from the top" reason. A COMPLETE
 * grab is restored (best effort) and this throws, refusing the clobber.
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

/** Restores a quarantined COMPLETE artifact (best effort) and refuses the publish. */
function refuseCompleteClobber(quarantinePath: string, scriptPath: string): never {
  try {
    // If another writer already republished to `scriptPath` in the meantime,
    // this fails and ours stays quarantined (cleaned up by the caller) — we
    // lose cleanly either way.
    fs.renameSync(quarantinePath, scriptPath);
  } catch {
    /* already re-occupied by another writer's publish */
  }
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
