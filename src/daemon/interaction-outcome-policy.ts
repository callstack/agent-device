import { dispatchCommand, type CommandFlags } from '../core/dispatch.ts';
import { isMobilePlatform } from '../utils/device.ts';
import type { SnapshotNode, SnapshotState } from '../utils/snapshot.ts';
import { emitDiagnostic } from '../utils/diagnostics.ts';
import { contextFromFlags } from './context.ts';
import type { SessionState } from './types.ts';

const OUTCOME_RETRY_WINDOW_MS = 30_000;
const OUTCOME_RETRY_ATTEMPTS = 2;
const RECT_TOLERANCE_PX = 1;

export type InteractionSurfaceSignature = NonNullable<
  SessionState['pendingInteractionOutcome']
>['preSignature'];

export type InteractionSurfaceChange = 'changed' | 'unchanged' | 'ambiguous';

function shouldRetryTouchOnNoChange(flags: CommandFlags | undefined): boolean {
  return flags?.interactionOutcome?.retryOnNoChange === true;
}

export function markPendingInteractionOutcome(params: {
  session: SessionState;
  command: string;
  positionals: string[];
  flags: CommandFlags | undefined;
  preSnapshot: SnapshotState | undefined;
}): void {
  const { session, command, positionals, flags, preSnapshot } = params;
  if (!shouldRetryTouchOnNoChange(flags)) return;
  if (!supportsInteractionOutcomePolicy(session)) return;
  const retryCommand = retryCommandForTap(command);
  if (!retryCommand) return;
  if (!isCoordinatePair(positionals)) return;
  const preSignature = buildInteractionSurfaceSignature(preSnapshot?.nodes ?? []);
  if (preSignature.length === 0) return;
  session.pendingInteractionOutcome = {
    action: command,
    command: retryCommand,
    positionals,
    flags: stripInternalInteractionFlags(flags),
    markedAt: Date.now(),
    attemptsRemaining: OUTCOME_RETRY_ATTEMPTS,
    preSignature,
  };
}

export function getActivePendingInteractionOutcome(
  session: SessionState | undefined,
): NonNullable<SessionState['pendingInteractionOutcome']> | undefined {
  const pending = session?.pendingInteractionOutcome;
  if (!session || !pending) return undefined;
  if (!supportsInteractionOutcomePolicy(session)) {
    clearPendingInteractionOutcome(session);
    return undefined;
  }
  if (Date.now() - pending.markedAt > OUTCOME_RETRY_WINDOW_MS) {
    clearPendingInteractionOutcome(session);
    return undefined;
  }
  return pending;
}

export function clearPendingInteractionOutcome(session: SessionState | undefined): void {
  if (!session?.pendingInteractionOutcome) return;
  session.pendingInteractionOutcome = undefined;
}

export async function retryPendingInteractionOutcome(params: {
  session: SessionState;
  pending: NonNullable<SessionState['pendingInteractionOutcome']>;
  logPath: string;
  snapshot: SnapshotState;
}): Promise<{ retried: boolean; change: InteractionSurfaceChange }> {
  const { session, pending, snapshot } = params;
  const change = classifyInteractionSurfaceChange(
    pending.preSignature,
    buildInteractionSurfaceSignature(snapshot.nodes),
  );
  if (change !== 'unchanged' || pending.attemptsRemaining <= 0) {
    return { retried: false, change };
  }

  const startedAt = Date.now();
  pending.attemptsRemaining -= 1;
  // Opt-in Maestro retries intentionally re-fire the same coordinate tap; delayed or
  // non-visual side effects can duplicate, but unchanged visual taps are the target gap.
  await dispatchCommand(session.device, pending.command, pending.positionals, pending.flags?.out, {
    ...contextFromFlags(params.logPath, pending.flags, session.appBundleId, session.trace?.outPath),
    surface: session.surface,
  });
  emitDiagnostic({
    level: 'info',
    phase: 'interaction_no_change_retry',
    data: {
      action: pending.action,
      attemptsRemaining: pending.attemptsRemaining,
      durationMs: Date.now() - startedAt,
    },
  });
  return { retried: true, change };
}

export function emitInteractionSettled(params: {
  pending: NonNullable<SessionState['pendingInteractionOutcome']>;
  change: InteractionSurfaceChange;
  attempts: number;
  startedAt: number;
}): void {
  emitDiagnostic({
    level: params.attempts > 0 ? 'info' : 'debug',
    phase: 'interaction_settled',
    data: {
      action: params.pending.action,
      change: params.change,
      attempts: params.attempts,
      durationMs: Date.now() - params.startedAt,
    },
  });
}

export function emitInteractionSettleTimeout(params: {
  pending: NonNullable<SessionState['pendingInteractionOutcome']>;
  attempts: number;
  startedAt: number;
}): void {
  emitDiagnostic({
    level: 'warn',
    phase: 'interaction_settle_timeout',
    data: {
      action: params.pending.action,
      attempts: params.attempts,
      durationMs: Date.now() - params.startedAt,
    },
  });
}

export function stripInternalInteractionFlags(
  flags: CommandFlags | undefined,
): CommandFlags | undefined {
  if (!flags?.interactionOutcome && !flags?.postGestureStabilization) return flags;
  const {
    interactionOutcome: _interactionOutcome,
    postGestureStabilization: _postGestureStabilization,
    ...publicFlags
  } = flags;
  return publicFlags;
}

export function buildInteractionSurfaceSignature(
  nodes: SnapshotNode[],
): InteractionSurfaceSignature {
  const occurrenceCounts = new Map<string, number>();
  const entries: InteractionSurfaceSignature = [];

  for (const node of nodes) {
    const entry = buildInteractionSurfaceEntry(node, occurrenceCounts);
    if (entry) entries.push(entry);
  }

  return entries;
}

export function classifyInteractionSurfaceChange(
  before: InteractionSurfaceSignature,
  after: InteractionSurfaceSignature,
): InteractionSurfaceChange {
  if (before.length === 0 || after.length === 0) return 'ambiguous';
  if (areInteractionSurfaceSignaturesStable(before, after)) return 'unchanged';
  return 'changed';
}

export function areInteractionSurfaceSignaturesStable(
  left: InteractionSurfaceSignature,
  right: InteractionSurfaceSignature,
): boolean {
  if (left.length !== right.length) return false;
  for (let index = 0; index < left.length; index += 1) {
    const a = left[index];
    const b = right[index];
    if (!a || !b || a.key !== b.key) return false;
    if (Math.abs(a.x - b.x) > RECT_TOLERANCE_PX) return false;
    if (Math.abs(a.y - b.y) > RECT_TOLERANCE_PX) return false;
    if (Math.abs(a.width - b.width) > RECT_TOLERANCE_PX) return false;
    if (Math.abs(a.height - b.height) > RECT_TOLERANCE_PX) return false;
  }
  return true;
}

function supportsInteractionOutcomePolicy(session: SessionState): boolean {
  return isMobilePlatform(session.device.platform);
}

function retryCommandForTap(command: string): string | undefined {
  if (command === 'click') return 'press';
  if (command === 'press') return 'press';
  return undefined;
}

function buildInteractionSurfaceEntry(
  node: SnapshotNode,
  occurrenceCounts: Map<string, number>,
): InteractionSurfaceSignature[number] | undefined {
  if (!node.rect) return undefined;
  if (!isFiniteRect(node.rect)) return undefined;
  if (isScrollIndicator(node)) return undefined;
  const semanticKey = interactionSurfaceSemanticKey(node);
  if (!semanticKey) return undefined;
  const occurrence = occurrenceCounts.get(semanticKey) ?? 0;
  occurrenceCounts.set(semanticKey, occurrence + 1);
  return {
    key: `${semanticKey}|#${occurrence}`,
    x: Math.round(node.rect.x),
    y: Math.round(node.rect.y),
    width: Math.round(node.rect.width),
    height: Math.round(node.rect.height),
  };
}

function interactionSurfaceSemanticKey(node: SnapshotNode): string | undefined {
  const semanticKey = [
    node.identifier,
    node.label,
    node.value,
    node.type,
    node.role,
    node.enabled === false ? 'disabled' : 'enabled',
    node.selected === true ? 'selected' : 'unselected',
    node.hittable === true ? 'hittable' : 'not-hittable',
  ]
    .map((value) => (typeof value === 'string' ? value.trim() : ''))
    .join('|');
  return semanticKey.replaceAll('|', '') ? semanticKey : undefined;
}

function isCoordinatePair(positionals: string[]): boolean {
  if (positionals.length !== 2) return false;
  return positionals.every((value) => Number.isFinite(Number(value)));
}

function isFiniteRect(rect: NonNullable<SnapshotNode['rect']>): boolean {
  const values = [rect.x, rect.y, rect.width, rect.height];
  return values.every((value) => Number.isFinite(value)) && rect.width > 0 && rect.height > 0;
}

function isScrollIndicator(node: SnapshotNode): boolean {
  const label = `${node.label ?? ''} ${node.identifier ?? ''}`.toLowerCase();
  return label.includes('scroll bar');
}
