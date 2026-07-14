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
 * Ordinary (non-repair) recording is never blocked here (no `saveScriptBoundary`) —
 * this gate only decides whether `write()` attempts a publish AT ALL. It says
 * nothing about what happens once it does: `publishHealedScriptAtomically`'s
 * refuse-on-exist applies to that attempted publish uniformly, repair-armed or
 * not (see its doc comment) — ordinary recording is never blocked from trying,
 * but it can still be refused if the target already exists.
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
      publishHealedScriptAtomically({ scriptPath, script });
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
      // recording keeps its existing SHAPE of behavior: an AppError still
      // fails loud (thrown, not swallowed into `{written:false}`) and any other
      // fs error is a quiet skip — but an AppError is no longer only
      // theoretical here. Since `publishHealedScriptAtomically` refuses ANY
      // pre-existing target uniformly (maintainer-approved: refuse-on-exist
      // applies to ordinary recording too, not just repair heals), an ordinary
      // `open`/`close --save-script` write against an existing target now
      // throws that same no-clobber AppError, surfacing here as a genuine
      // "fails loud" case rather than the "none is raised on that path" it was
      // before that change.
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
 * ADR 0012 decision 6, no-clobber (maintainer-approved simplification):
 * publishes `script` to `scriptPath` atomically, refusing ANY pre-existing
 * target — complete or partial, the default healed sibling or an explicit
 * `--save-script=<path>` alike.
 *
 * This is `write()`'s ONLY publish primitive, called unconditionally for
 * every target — a repair-armed heal AND an ordinary, non-repair
 * `open`/`close --save-script` recording alike. There is no
 * repair-armed-vs-ordinary branch here (an earlier design had one —
 * `publishOverwriteAtomically`, rename-replace for ordinary writes — since
 * removed): an ordinary recording's target is refused exactly like a healed
 * repair's, never silently overwritten. `--force`/`--overwrite` is a future
 * escape hatch (#1258), not implemented today.
 *
 * The temp file is created in the SAME DIRECTORY as the target (never
 * `/tmp`), so the publish itself is a single intra-directory `linkSync`:
 * atomic create-exclusive, first writer wins. That single primitive is
 * enough — a concurrent complete-vs-complete race is already correct this
 * way (the loser sees `EEXIST` and is refused), and a partial healed file
 * left behind by an aborted/reaped repair is a degenerate state: the caller
 * clears it explicitly (remove it, or pick another `--save-script` path)
 * rather than having it silently replaced. No lock, no lease, no steal, no
 * overwrite.
 */
function publishHealedScriptAtomically(params: { scriptPath: string; script: string }): void {
  const { scriptPath, script } = params;
  const dir = path.dirname(scriptPath);
  const tempPath = path.join(
    dir,
    `.${path.basename(scriptPath)}.${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.tmp`,
  );
  fs.writeFileSync(tempPath, script);
  try {
    // Atomic create-exclusive: EEXIST iff a file already sits at scriptPath.
    fs.linkSync(tempPath, scriptPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    throw new AppError(
      'COMMAND_FAILED',
      `A file already exists at ${scriptPath}; remove it or pass replay --save-script=<other-path> so an existing healed script is never overwritten.`,
    );
  } finally {
    // linkSync leaves the temp hard-link behind on success; an error leaves
    // it too — always clean up whatever of our own temp remains.
    fs.rmSync(tempPath, { force: true });
  }
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
