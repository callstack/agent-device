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

export type SessionScriptWriteResult = { written: false } | { written: true; path: string };

export class SessionScriptWriter {
  private readonly sessionsDir: string;

  constructor(sessionsDir: string) {
    this.sessionsDir = sessionsDir;
  }

  write(session: SessionState): SessionScriptWriteResult {
    let scriptPath: string | undefined;
    try {
      if (!session.recordSession) return { written: false };
      scriptPath = this.resolveScriptPath(session);
      assertNoDefaultedHealedClobber(session, scriptPath);
      const scriptDir = path.dirname(scriptPath);
      if (!fs.existsSync(scriptDir)) fs.mkdirSync(scriptDir, { recursive: true });
      const script = formatSessionScript(session);
      fs.writeFileSync(scriptPath, script);
      return { written: true, path: scriptPath };
    } catch (error) {
      // ADR 0012 decision 6, R4: an AppError here means the script would be
      // unreplayable (a bare `@ref` that never resolved to a selector) —
      // that must fail loud, not be swallowed into a quiet `{written:
      // false}` like an ordinary fs write failure below.
      if (error instanceof AppError) throw error;
      emitDiagnostic({
        level: 'warn',
        phase: 'session_script_write_failed',
        data: {
          session: session.name,
          path: scriptPath,
          error: error instanceof Error ? error.message : String(error),
        },
      });
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

function formatSessionScript(session: SessionState): string {
  return formatScript(session, buildOptimizedActions(session));
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
 * ADR 0012 decision 6 (P2): the default `<original-stem>.healed.ad` sibling
 * path is deterministic, so a second repair against the same original would
 * silently clobber an unreviewed prior healed script — undercutting the
 * ADR's "a human reviews the diff and promotes it." Refuse loudly (fail-loud
 * per R4's philosophy) unless the caller passes an explicit
 * `--save-script=<path>` (which clears the defaulted flag). Only guards the
 * DEFAULT healed path; an explicit `<out>` may overwrite as the caller
 * directed.
 */
function assertNoDefaultedHealedClobber(session: SessionState, scriptPath: string): void {
  if (!session.saveScriptDefaultedHealedPath) return;
  if (!fs.existsSync(scriptPath)) return;
  throw new AppError(
    'COMMAND_FAILED',
    `A prior healed script already exists at ${scriptPath}; pass replay --save-script=<path> to write elsewhere, or remove/rename it first, so an unreviewed healed script is never clobbered.`,
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

function formatScript(session: SessionState, actions: SessionAction[]): string {
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
