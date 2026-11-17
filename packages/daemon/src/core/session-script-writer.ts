import type { SessionAction } from '@agent-device/contracts/session';
import crypto from 'node:crypto';
import path from 'node:path';
import { publicPlatformString } from '@agent-device/kernel/device';
import { dragGesturePayloadFromPositionals } from '@agent-device/contracts/gesture-normalization';
import { emitDiagnostic } from '@agent-device/host-kit/diagnostics';
import { AppError } from '@agent-device/kernel/errors';
import { ensurePrivateDaemonStateDir } from '@agent-device/daemon-contracts/daemon-registration-owner';
import {
  inferFillText,
  appendScriptSeriesFlags,
  escapeReplayAction,
  formatPortableActionLine,
  formatScriptArg,
  formatScriptStringLiteral,
  formatTargetAnnotationLines,
  isClickLikeCommand,
  isTouchTargetCommand,
  stripRecordedRefGeneration,
} from '@agent-device/ad-script';
import { expandSessionPath, safeSessionName } from '@agent-device/host-kit/session-paths';
import { childPath, publishScriptFileSync } from '@agent-device/host-kit/file';
import type { SessionState } from './session-state.ts';
import {
  NO_SCRIPT_PUBLICATION,
  commitRepair,
  isRecordingPublication,
  isRepairCommittable,
  scriptTargetPath,
} from './session-script-publication-state.ts';
import { isRepairArmedSession, repairSessionBoundary } from './session-replay-transaction.ts';
import {
  assertActivePublicationPortability,
  toActivePublicationFailure,
  validateActivePublicationActions,
} from './session-script-active-publication.ts';

/**
 * `{ written: true; path }` — committed. `{ written: false }` (no `error`) — intentionally not
 * written (not recording, an aborted/incomplete repair transaction, an aborted ordinary authoring
 * recording (#1533), or an idempotent already-committed no-op). `{ written: false; error }` — an
 * armed write was attempted and failed (no-clobber refusal, a bare-`@ref` R4 failure, or a
 * filesystem error) for a repair commit, an active publication, or an ordinary recording alike.
 * The writer never throws: close surfaces the error, and teardown keeps it in the
 * `session_script_write_failed` diagnostic (ADR 0012 decision 6, BLOCKER 2).
 */
export type SessionScriptWriteResult =
  | { written: true; path: string; actionCount: number }
  | { written: false; error?: AppError };

export type SessionScriptWriteOptions = {
  force?: boolean;
  /** ADR 0016 publishes an armed ordinary recording while keeping its session live. */
  publication?: 'teardown' | 'active';
};

/**
 * ADR 0012 decision 6 (Fix 4, C2): trailer comment marking a healed `.ad` as a
 * COMPLETE, review-worthy repair artifact. An ordinary `#` comment to every
 * reader (old and new) — it binds to nothing (`parseTargetAnnotationCommentLine`
 * only recognizes the `target-v1` prefix), so it never participates in the
 * target-annotation binding rule. Written only when a repair-armed session's
 * write reaches this point at all, since `write()` already gated that on the
 * transaction being COMPLETE — so every write carrying it IS a complete,
 * committed transaction.
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
 * Ordinary (non-repair) recording is never blocked here (no repair variant) —
 * this gate only decides whether `write()` attempts a publish AT ALL. It says
 * nothing about what happens once it does: `publishHealedScriptAtomically`'s
 * refuse-on-exist applies to that attempted publish uniformly, repair-armed or
 * not (see its doc comment) — ordinary recording is never blocked from trying,
 * but it can still be refused if the target already exists.
 */
function isRepairArmedWriteBlocked(session: SessionState): boolean {
  const state = session.scriptPublication ?? NO_SCRIPT_PUBLICATION;
  if (state.kind !== 'repair') return false;
  if (state.status === 'committed') return true;
  return !isRepairCommittable(state);
}

/**
 * The single "may this session publish AT ALL" question, asked once by `write()` before any
 * formatting or filesystem work, and answered entirely from the publication aggregate:
 *
 * - a lifecycle that is not recording publishes nothing. That covers the session that never
 *   armed, the ABORTED authoring recording whose terminality #1533 turned into a rule, and the
 *   already-PUBLISHED one whose second write must no-op.
 * - a repair transaction that is committed or not yet committable (above).
 *
 * There is no separate ABORTED check here any more. `isRecordingPublication` answers false for a
 * terminal authoring lifecycle, so the refusal `close` promises the caller ("Retry with plain
 * close; it will tear down the session without writing") holds from every path reaching the
 * writer — bare `close`, teardown, idle-reap, active publication — without a second gate that
 * could disagree with the first.
 */
function isPublicationWriteBlocked(session: SessionState): boolean {
  if (!isRecordingPublication(session.scriptPublication ?? NO_SCRIPT_PUBLICATION)) return true;
  return isRepairArmedWriteBlocked(session);
}

export class SessionScriptWriter {
  /** The runtime host's working directory, the base every recorded script target resolves against. */
  private readonly hostCwd: string;
  /** The directory this store's sessions live in, spelled the way the path owner spells it. */
  private readonly sessionsDir: string;
  /** The state base that directory hangs off, as the daemon's path owner spells that base. */
  private readonly stateBase: string;

  /**
   * `stateBase` is the state directory `sessionsDir` was built from, and the default is that directory's own
   * parent. The daemon passes it explicitly because the two are NOT the same text once the setting names the
   * state dir through a link and a step back — see {@link resolveScriptDestination}.
   */
  constructor(sessionsDir: string, hostCwd: string, stateBase = path.dirname(sessionsDir)) {
    this.hostCwd = hostCwd;
    this.sessionsDir = sessionsDir;
    this.stateBase = stateBase;
  }

  write(session: SessionState, options?: SessionScriptWriteOptions): SessionScriptWriteResult {
    const repairArmed = isRepairArmedSession(session);
    const activePublication = options?.publication === 'active';
    let scriptPath: string | undefined;
    try {
      if (isPublicationWriteBlocked(session)) return { written: false };
      const prepared = prepareSessionScript(session, {
        appendCompleteSentinel: repairArmed,
        activePublication,
      });
      const remote =
        session.scriptPublication?.kind === 'authoring' &&
        session.scriptPublication.remoteDelivery !== undefined;
      const destination = this.resolveScriptDestination(session, remote);
      scriptPath = destination.path;
      if (destination.pickedByDaemon && !destination.privateChain) {
        throw daemonStateUntrustedFailure(destination.path);
      }
      // #1258: `options.force` is the caller's already-merged decision
      // (`effectiveWriteForce` — a live flag or the per-target grant), not
      // read from `session` directly here, so this stays a pure
      // formatting+publish step.
      // host-kit owns the rest (#4565): the publisher walks the chain, refuses a destination another
      // local user can steer BEFORE creating anything, creates what is missing at 0700 inside the
      // directory it judged, and judges that completed chain before the entry is created.
      publishHealedScriptAtomically({ scriptPath, script: prepared.script, force: options?.force });
      // COMMITTED: idempotent guard above + teardown's abort/tombstone routing.
      if (repairArmed) {
        session.scriptPublication = commitRepair(
          session.scriptPublication ?? NO_SCRIPT_PUBLICATION,
        );
      }
      return { written: true, path: scriptPath, actionCount: prepared.actionCount };
    } catch (error) {
      return handleSessionScriptWriteFailure({
        session,
        error,
        scriptPath,
        repairArmed,
        activePublication,
      });
    }
  }

  /**
   * Where this write's script goes, and whether the daemon picked that path itself.
   *
   * A caller's `--save-script=<path>` is the caller's own destination, and the destination rule in host-kit
   * is what judges it. Everything else is a path the daemon picked for itself — a default recording under
   * `sessions/`, or a remote version under `sessions/remote-scripts/`, each a fresh file in a private (0700)
   * directory. Ensuring that directory answers whether the chain from the state base is private ground, which
   * is what the refusal below is for, and its `path` is the VERIFIED spelling of that directory — the only name
   * a script of this daemon's is ever joined onto. Startup keeps going either way (#4565).
   */
  private resolveScriptDestination(
    session: SessionState,
    remote: boolean,
  ): { path: string; pickedByDaemon: boolean; privateChain: boolean } {
    // Re-spelled below the base, not used as the store handed it over. The daemon's path owner keeps the
    // setting's own text for the base and builds `sessionsDir` with `path.join`, which folds a `..` out of
    // it, so the folded name is NOT the chain the walk judges — and only the chain gets created and judged.
    // A caller that names no base gets its own parent, so this answers the directory it was given.
    const sessionsDir = childPath(this.stateBase, path.basename(this.sessionsDir));
    if (remote) {
      const directory = ensurePrivateDaemonStateDir(
        childPath(sessionsDir, 'remote-scripts'),
        this.stateBase,
      );
      return {
        ...directory,
        pickedByDaemon: true,
        path: path.join(directory.path, `${crypto.randomUUID()}.ad`),
      };
    }
    const targetPath = scriptTargetPath(session.scriptPublication ?? NO_SCRIPT_PUBLICATION);
    if (targetPath) {
      return {
        path: expandSessionPath(targetPath, this.hostCwd),
        pickedByDaemon: false,
        privateChain: true,
      };
    }
    const safeName = safeSessionName(session.name);
    const timestamp = new Date(session.createdAt).toISOString().replaceAll(/[:.]/g, '-');
    const own = ensurePrivateDaemonStateDir(sessionsDir, this.stateBase);
    return {
      ...own,
      pickedByDaemon: true,
      path: path.join(own.path, `${safeName}-${timestamp}.ad`),
    };
  }
}

function prepareSessionScript(
  session: SessionState,
  options: { appendCompleteSentinel: boolean; activePublication: boolean },
): { script: string; actionCount: number } {
  const actions = buildOptimizedActions(session, { strictPortableRefs: options.activePublication });
  if (options.activePublication) validateActivePublicationActions(actions);
  return {
    script: formatScript(session, actions, options.appendCompleteSentinel),
    actionCount: actions.length,
  };
}

/**
 * `write()`'s catch-block classifier: diagnose, then return the failure as a typed error.
 *
 * ADR 0012 decision 6, R4 + BLOCKER 2: every armed write failure (no-clobber refusal, bare-`@ref`,
 * or a filesystem error alike) is returned as `{ written: false, error }`, never thrown and never
 * swallowed, so close can report it and teardown can continue to retire the session.
 */
function handleSessionScriptWriteFailure(params: {
  session: SessionState;
  error: unknown;
  scriptPath: string | undefined;
  repairArmed: boolean;
  activePublication: boolean;
}): SessionScriptWriteResult {
  const { session, error, scriptPath, repairArmed, activePublication } = params;
  emitDiagnostic({
    level: 'warn',
    phase: 'session_script_write_failed',
    data: {
      session: session.name,
      path: scriptPath,
      error: error instanceof Error ? error.message : String(error),
    },
  });
  if (repairArmed) {
    return { written: false, error: toRepairCommitFailure(error, scriptPath) };
  }
  if (activePublication) {
    return { written: false, error: toActivePublicationFailure(error, scriptPath) };
  }
  return { written: false, error: toOrdinaryWriteFailure(error, scriptPath) };
}

/**
 * A filesystem failure that has to reach the caller as its own typed error: an ordinary recording
 * carries `script_write_failed` with the path it could not be written to, and both name what was being
 * written, because the same writer publishes a recording and a healed repair.
 */
function toScriptWriteFailure(
  error: unknown,
  scriptPath: string | undefined,
  subject: Readonly<{ noun: string; hint: string; reportsPath?: boolean }>,
): AppError {
  const detail = error instanceof Error ? error.message : String(error);
  const where = scriptPath === undefined ? '' : ` to ${scriptPath}`;
  return new AppError(
    'COMMAND_FAILED',
    `Failed to write the ${subject.noun}${where}: ${detail}`,
    {
      ...(subject.reportsPath === true && scriptPath !== undefined
        ? { reason: 'script_write_failed' as const, path: scriptPath }
        : {}),
      hint: subject.hint,
    },
    error,
  );
}

/**
 * Refusal for a script the daemon was about to write on a state chain the repair did not accept: a path
 * the daemon picked for itself, on ground it could not establish as its own. The destination walk is not
 * what refuses it — the walk ACCEPTS a link whose parent others cannot write (ADR 0016).
 */
function daemonStateUntrustedFailure(scriptPath: string): AppError {
  return new AppError(
    'COMMAND_FAILED',
    `The recording was not written: the daemon's own state directory is not private ground, so ${scriptPath} does not name a directory this daemon owns.`,
    {
      reason: 'state_chain_untrusted',
      path: scriptPath,
      hint:
        'A level of the daemon state chain, or a directory above it, is a symbolic link, is owned by ' +
        'another user, or is open to other users, so the daemon cannot call it private ground. This is the ' +
        'shape of a bind-mounted CI volume, a container image that leaves the state directory to another ' +
        'uid, or a state directory inside a shared directory anyone can write. Make the daemon own that ' +
        'tree (chown -R the state directory to the daemon user), or point AGENT_DEVICE_STATE_DIR at a ' +
        'directory it owns, then re-record. A recording to an explicit --save-script path is unaffected.',
    },
  );
}

function toOrdinaryWriteFailure(error: unknown, scriptPath: string | undefined): AppError {
  if (error instanceof AppError) return error;
  return toScriptWriteFailure(error, scriptPath, {
    noun: 'session script',
    reportsPath: true,
    hint: 'Check the target path and its permissions, then re-record with open --save-script.',
  });
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
  return toScriptWriteFailure(error, scriptPath, {
    noun: 'healed script',
    hint: 'The repair transaction completed but the healed .ad could not be published; check the target path and permissions, then retry close --save-script.',
  });
}

/**
 * ADR 0012 decision 6, no-clobber (maintainer-approved simplification):
 * publishes `script` to `scriptPath` atomically, refusing ANY pre-existing
 * target — complete or partial, the default healed sibling or an explicit
 * `--save-script=<path>` alike — UNLESS `force` is set (#1258).
 *
 * This is `write()`'s ONLY publish primitive, called unconditionally for
 * every target — a repair-armed heal AND an ordinary, non-repair
 * `open`/`close --save-script` recording alike. There is no
 * repair-armed-vs-ordinary branch here: an ordinary recording's target is
 * refused exactly like a healed repair's, and `force` overwrites exactly
 * like a healed repair's.
 *
 * The temp file is created in the SAME DIRECTORY as the target (never
 * `/tmp`). Default (no `force`): the publish is a single intra-directory
 * `linkSync`: atomic create-exclusive, first writer wins. That single
 * primitive is enough — a concurrent complete-vs-complete race is already
 * correct this way (the loser sees `EEXIST` and is refused), and a partial
 * healed file left behind by an aborted/reaped repair is a degenerate
 * state: the caller clears it explicitly (remove it, or pick another
 * `--save-script` path) rather than having it silently replaced. No lock,
 * no lease, no steal, no overwrite.
 *
 * `force`/`--overwrite` (#1258): `renameSync` instead — an atomic REPLACE
 * within the same directory (on POSIX; Node's Windows implementation uses
 * `MoveFileEx` with `MOVEFILE_REPLACE_EXISTING`), so there is no window
 * where `scriptPath` is briefly missing and no separate unlink step. The
 * caller opted into overwriting explicitly (a live `--force`/`--overwrite`,
 * or one persisted on the session from arm time — see
 * `SessionState.saveScriptForce`), so first-writer-wins no longer applies:
 * the last write wins instead, same as any ordinary file overwrite.
 */
function publishHealedScriptAtomically(params: {
  scriptPath: string;
  script: string;
  force?: boolean;
}): void {
  const { scriptPath, script, force } = params;
  try {
    publishScriptFileSync({
      destination: scriptPath,
      contents: script,
      publish: force ? 'replace' : 'link-exclusive',
    });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    throw new AppError(
      'COMMAND_FAILED',
      `A file already exists at ${scriptPath}; remove it, pass replay --save-script=<other-path>, or pass --force/--overwrite to replace it.`,
      { reason: 'script_target_exists', path: scriptPath },
    );
  }
}

function buildOptimizedActions(
  session: SessionState,
  options: { strictPortableRefs?: boolean } = {},
): SessionAction[] {
  // ADR 0012 decision 6, R6: a repair-armed session (armed by `replay
  // --save-script`) serializes only the actions from its boundary watermark
  // onward — the repair run's own execution path — never the whole session
  // history. Absent a boundary (ordinary `open`/`close --save-script`), this
  // slices from 0: unchanged, full-history behavior.
  const boundary = repairSessionBoundary(session);
  const repairArmed = boundary !== undefined;
  const relevantActions = session.actions.slice(boundary ?? 0);
  const optimized: SessionAction[] = [];
  for (const action of relevantActions) {
    if (
      action.command === 'snapshot' &&
      action.publicationIntent !== 'authored' &&
      !(repairArmed && action.publicationIntent === 'explicit-record')
    ) {
      continue;
    }
    const optimizedAction = optimizeSelectorChainAction(action);
    if (optimizedAction) {
      optimized.push(optimizedAction);
      continue;
    }
    // R4 is scoped to a repair-armed session, not the existing refLabel/
    // scoped-snapshot fallback ordinary `open`/`close --save-script` keeps.
    if (repairArmed || options.strictPortableRefs) assertNoUnresolvedRefFallback(action);
    const scopedSnapshot = buildScopedSnapshotAction(session, action);
    if (scopedSnapshot) optimized.push(scopedSnapshot);
    optimized.push(action);
  }
  if (options.strictPortableRefs) assertActivePublicationPortability(optimized);
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
  const drag =
    action.command === 'gesture'
      ? dragGesturePayloadFromPositionals(action.positionals ?? [])
      : undefined;
  if (drag) {
    assertNoUnresolvedDragEndpoint(drag);
    return;
  }
  if (!isSelectorTargetingCommand(action.command)) return;
  const refPositional =
    action.command === 'get' ? action.positionals?.[1] : action.positionals?.[0];
  if (!refPositional?.startsWith('@')) return;
  throw new AppError(
    'COMMAND_FAILED',
    `Cannot write recorded step "${action.command} ${refPositional}" to a script: it never resolved to a selector, so the ref would not resolve in a fresh replay session.`,
  );
}

function assertNoUnresolvedDragEndpoint(drag: { source: string; destination: string }): void {
  const refPositional = [drag.source, drag.destination].find((value) => value.startsWith('@'));
  if (!refPositional) return;
  throw new AppError(
    'COMMAND_FAILED',
    `Cannot write recorded drag endpoint "${refPositional}" to a script: it never resolved to a selector, so the ref would not resolve in a fresh replay session.`,
  );
}

function optimizeSelectorChainAction(action: SessionAction): SessionAction | undefined {
  const selectorExpr = readSelectorChainExpression(action);
  if (!selectorExpr || !isSelectorTargetingCommand(action.command)) return undefined;
  if (isClickLikeCommand(action.command) || action.command === 'hover') {
    return { ...action, positionals: [selectorExpr] };
  }
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
  // `''` is the explicit clear request, so only a fill that recorded no text argument is skipped.
  const recordedText =
    typeof action.result?.text === 'string' || (action.positionals?.length ?? 0) > 1;
  return recordedText
    ? { ...action, positionals: [selectorExpr, inferFillText(action)] }
    : undefined;
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
    ...(action.livePlaceholders ? { livePlaceholders: action.livePlaceholders } : {}),
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
    // Replay interpolates the written positionals, flags, and runtime hints; only the
    // placeholders the recorder inserted stay live.
    lines.push(formatActionLine(escapeReplayAction(action, new Set(action.livePlaceholders))));
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
