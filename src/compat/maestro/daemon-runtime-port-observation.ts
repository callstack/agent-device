import { createHash } from 'node:crypto';
import { createRequestCanceledError } from '../../request/cancel.ts';
import {
  getSnapshotReferenceFrame,
  type TouchReferenceFrame,
} from '../../daemon/touch-reference-frame.ts';
import { AppError } from '../../kernel/errors.ts';
import { isPositiveFiniteRect, rectContains } from '../../kernel/rect.ts';
import type { Rect, SnapshotState } from '../../kernel/snapshot.ts';
import type { MaestroObservation, MaestroObservationCondition } from './engine-types.ts';
import { MAESTRO_COMPATIBILITY_PRESETS } from './compatibility-policy.ts';
import type { MaestroPlatform, MaestroSelector } from './program-ir.ts';
import { literalFromMaestroRegex } from './selector-regex.ts';
import {
  resolveMaestroTargetFromSnapshot,
  type MaestroTargetQuery as SnapshotTargetQuery,
} from './runtime-targets.ts';
import type {
  MaestroDispatchSelector,
  MaestroRuntimeReadContext,
  MaestroTargetMatch,
  MaestroTargetQuery,
} from './runtime-port-types.ts';

export const MAESTRO_OBSERVATION_POLL_MS = MAESTRO_COMPATIBILITY_PRESETS.observation.pollIntervalMs;
export type DaemonMaestroRuntimeDependencies = {
  readonly now: () => number;
  readonly sleep: (milliseconds: number, signal?: AbortSignal) => Promise<void>;
};

export type MaestroSnapshotReader = (context: MaestroRuntimeReadContext) => Promise<SnapshotState>;

export type MaestroSnapshotSource = {
  readonly capture: MaestroSnapshotReader;
  readonly bindObservation: (observation: MaestroObservation) => MaestroObservation;
  readonly reuseObservation: (context: MaestroRuntimeReadContext) => SnapshotState | undefined;
  readonly invalidate: () => void;
  readonly requireStability: () => void;
  readonly prime: (generation: number, snapshot: SnapshotState) => void;
  readonly settlePending: (context: MaestroRuntimeReadContext) => Promise<void>;
};

export type MaestroTargetResolutionMode = 'tap' | 'swipe' | 'observe';

export async function captureRetriableMaestroSnapshot(
  params: {
    readonly context: MaestroRuntimeReadContext;
    readonly snapshot: MaestroSnapshotReader;
    readonly dependencies: DaemonMaestroRuntimeDependencies;
  },
  deadline: number,
): Promise<SnapshotState> {
  while (true) {
    throwIfAborted(params.context.signal);
    try {
      return await params.snapshot(params.context);
    } catch (error) {
      if (!isRetriableSnapshotError(error)) throw error;
      throwIfAborted(params.context.signal);
      const remaining = deadline - params.dependencies.now();
      if (remaining <= 0) throw error;
      await sleepWithinBudget(
        params.dependencies,
        Math.min(MAESTRO_OBSERVATION_POLL_MS, remaining),
        params.context.signal,
      );
    }
  }
}

export async function resolveTypedMaestroTarget(params: {
  readonly query: MaestroTargetQuery;
  readonly context: MaestroRuntimeReadContext;
  readonly snapshot: SnapshotState;
  readonly platform: Extract<MaestroPlatform, 'ios' | 'android'>;
}): Promise<MaestroTargetMatch> {
  return resolveTargetFromSnapshot({
    ...params,
    mode: params.query.purpose === 'swipe' ? 'swipe' : 'tap',
  });
}

function resolveTargetFromSnapshot(params: {
  readonly query: SnapshotTargetQuery & { readonly allowAtomicSelectorDispatch?: boolean };
  readonly context: MaestroRuntimeReadContext;
  readonly snapshot: SnapshotState;
  readonly platform: Extract<MaestroPlatform, 'ios' | 'android'>;
  readonly mode: MaestroTargetResolutionMode;
}): MaestroTargetMatch {
  const frame = getSnapshotReferenceFrame(params.snapshot);
  const resolution = resolveMaestroTargetFromSnapshot(
    params.snapshot,
    params.query,
    params.platform,
  );
  return targetMatchFromResolution(
    resolution,
    params.snapshot,
    params.context.generation,
    frame,
    params.query,
    params.platform,
    params.mode,
  );
}

export async function observeTypedMaestroCondition(params: {
  readonly condition: MaestroObservationCondition;
  readonly timeoutMs: number;
  readonly context: MaestroRuntimeReadContext;
  readonly snapshot: MaestroSnapshotReader;
  readonly dependencies: DaemonMaestroRuntimeDependencies;
  readonly platform: Extract<MaestroPlatform, 'ios' | 'android'>;
}): Promise<MaestroTargetMatch> {
  validateTimeout(params.timeoutMs, 'observation');
  let lastMatch: MaestroTargetMatch | undefined;
  const conditionDeadline = params.dependencies.now() + params.timeoutMs;

  while (true) {
    throwIfAborted(params.context.signal);
    const snapshot = await captureRetriableMaestroSnapshot(params, conditionDeadline);
    const match = resolveTargetFromSnapshot({
      query: { selector: params.condition.selector },
      context: params.context,
      snapshot,
      platform: params.platform,
      mode: 'observe',
    });
    lastMatch = match;
    if (conditionMatches(params.condition, match)) return match;
    if (params.dependencies.now() >= conditionDeadline) break;

    const remaining = conditionDeadline - params.dependencies.now();
    if (remaining > 0) {
      await sleepWithinBudget(
        params.dependencies,
        Math.min(MAESTRO_OBSERVATION_POLL_MS, remaining),
        params.context.signal,
      );
    }
  }

  throwIfAborted(params.context.signal);
  return requireObservationResult(lastMatch);
}

export async function scrollUntilTypedMaestroTarget(params: {
  readonly selector: MaestroSelector;
  readonly direction: string;
  readonly timeoutMs: number;
  readonly context: MaestroRuntimeReadContext;
  readonly snapshot: MaestroSnapshotReader;
  readonly scroll: (remainingMs: number) => Promise<SnapshotState>;
  readonly dependencies: DaemonMaestroRuntimeDependencies;
  readonly platform: Extract<MaestroPlatform, 'ios' | 'android'>;
}): Promise<MaestroTargetMatch> {
  validateTimeout(params.timeoutMs, 'scrollUntilVisible');
  const deadline = params.dependencies.now() + params.timeoutMs;
  let lastMatch: MaestroTargetMatch | undefined;
  let settledSnapshot: SnapshotState | undefined;

  while (true) {
    throwIfAborted(params.context.signal);
    const snapshot = settledSnapshot ?? (await captureRetriableMaestroSnapshot(params, deadline));
    settledSnapshot = undefined;
    lastMatch = resolveTargetFromSnapshot({
      query: { selector: params.selector },
      context: params.context,
      snapshot,
      platform: params.platform,
      mode: 'observe',
    });
    if (
      lastMatch.visiblePercentage ===
      MAESTRO_COMPATIBILITY_PRESETS.command.scrollUntilVisiblePercentage
    ) {
      return lastMatch;
    }
    if (params.dependencies.now() >= deadline) break;

    const remaining = deadline - params.dependencies.now();
    if (remaining > 0) {
      settledSnapshot = await params.scroll(remaining);
    }
  }

  throwIfAborted(params.context.signal);
  return requireObservationResult(lastMatch);
}

export async function waitForTypedSnapshotStability(params: {
  readonly timeoutMs: number;
  readonly context: MaestroRuntimeReadContext;
  readonly snapshot: MaestroSnapshotReader;
  readonly dependencies: DaemonMaestroRuntimeDependencies;
}): Promise<SnapshotState> {
  validateTimeout(params.timeoutMs, 'waitForAnimationToEnd');
  const deadline = params.dependencies.now() + params.timeoutMs;
  let previous = await captureRetriableMaestroSnapshot(params, deadline);
  let previousSignature = maestroSnapshotSignature(previous);

  while (true) {
    throwIfAborted(params.context.signal);
    const remaining = deadline - params.dependencies.now();
    if (remaining > 0) {
      await sleepWithinBudget(
        params.dependencies,
        Math.min(MAESTRO_OBSERVATION_POLL_MS, remaining),
        params.context.signal,
      );
    }
    const snapshot = await captureRetriableMaestroSnapshot(params, deadline);
    const signature = maestroSnapshotSignature(snapshot);
    if (signature === previousSignature) return snapshot;
    previous = snapshot;
    previousSignature = signature;

    if (params.dependencies.now() >= deadline) return previous;
  }
}

function snapshotViewportRect(frame: TouchReferenceFrame | undefined): Rect | undefined {
  return frame
    ? { x: 0, y: 0, width: frame.referenceWidth, height: frame.referenceHeight }
    : undefined;
}

function targetMatchFromResolution(
  resolution: ReturnType<typeof resolveMaestroTargetFromSnapshot>,
  snapshot: SnapshotState,
  generation: number,
  frame: TouchReferenceFrame | undefined,
  query: SnapshotTargetQuery & { allowAtomicSelectorDispatch?: boolean },
  platform: Extract<MaestroPlatform, 'ios' | 'android'>,
  mode: MaestroTargetResolutionMode,
): MaestroTargetMatch {
  if (!resolution.ok) {
    return {
      generation,
      matched: resolution.evidence.matched,
      visible: resolution.evidence.visible,
      candidateCount: resolution.evidence.candidateCount,
      ...(resolution.evidence.ref ? { ref: resolution.evidence.ref } : {}),
      ...(snapshotViewportRect(frame) ? { viewport: snapshotViewportRect(frame) } : {}),
    };
  }
  const dispatchSelector = resolveAtomicIosDispatchSelector({
    query,
    platform,
    mode,
    dispatchCandidates: resolution.dispatchCandidates,
  });
  const viewport = snapshotViewportRect(frame);
  return {
    generation,
    matched: true,
    visible: true,
    ...(viewport ? { visiblePercentage: visibleScreenPercentage(resolution.rect, viewport) } : {}),
    candidateCount: resolution.evidence.candidateCount,
    rect: resolution.rect,
    ...(resolution.evidence.ref ? { ref: resolution.evidence.ref } : {}),
    ...(viewport ? { viewport } : {}),
    ...(dispatchSelector ? { dispatchSelector } : {}),
    surfaceSignature: maestroSnapshotSignature(snapshot),
  };
}

function visibleScreenPercentage(rect: Rect, viewport: Rect): number {
  if (!isPositiveFiniteRect(rect) || !isPositiveFiniteRect(viewport)) return 0;
  if (rectContains(viewport, rect)) return 100;

  const width = Math.max(
    0,
    Math.min(rect.x + rect.width, viewport.x + viewport.width) - Math.max(rect.x, viewport.x),
  );
  const height = Math.max(
    0,
    Math.min(rect.y + rect.height, viewport.y + viewport.height) - Math.max(rect.y, viewport.y),
  );
  return (width * height * 100) / (rect.width * rect.height);
}

function resolveAtomicIosDispatchSelector(params: {
  query: SnapshotTargetQuery & { allowAtomicSelectorDispatch?: boolean };
  platform: Extract<MaestroPlatform, 'ios' | 'android'>;
  mode: MaestroTargetResolutionMode;
  dispatchCandidates: number;
}): MaestroDispatchSelector | undefined {
  const { query, platform, mode, dispatchCandidates } = params;
  if (!allowsAtomicIosDispatch(query, platform, mode) || dispatchCandidates !== 1) return undefined;
  return singleExactDispatchSelector(query.selector);
}

function allowsAtomicIosDispatch(
  query: SnapshotTargetQuery & { allowAtomicSelectorDispatch?: boolean },
  platform: Extract<MaestroPlatform, 'ios' | 'android'>,
  mode: MaestroTargetResolutionMode,
): boolean {
  return (
    platform === 'ios' &&
    mode === 'tap' &&
    query.allowAtomicSelectorDispatch === true &&
    query.index === undefined &&
    query.childOf === undefined
  );
}

function singleExactDispatchSelector(
  selector: MaestroSelector,
): MaestroDispatchSelector | undefined {
  const entries = Object.entries(selector).filter(([, value]) => value !== undefined);
  if (entries.length !== 1) return undefined;
  const [key, rawValue] = entries[0]!;
  if (!isDispatchSelectorKey(key) || typeof rawValue !== 'string') return undefined;
  const value = literalFromMaestroRegex(rawValue)?.trim();
  return value ? { key, value } : undefined;
}

function isDispatchSelectorKey(key: string): key is MaestroDispatchSelector['key'] {
  return key === 'id' || key === 'label' || key === 'text';
}

function conditionMatches(
  condition: MaestroObservationCondition,
  match: MaestroTargetMatch,
): boolean {
  return condition.kind === 'visible'
    ? match.matched && match.visible
    : !match.matched || !match.visible;
}

async function sleepWithinBudget(
  dependencies: DaemonMaestroRuntimeDependencies,
  milliseconds: number,
  signal: AbortSignal | undefined,
): Promise<void> {
  try {
    await dependencies.sleep(milliseconds, signal);
  } catch (error) {
    if (signal?.aborted) throw createRequestCanceledError();
    throw error;
  }
  throwIfAborted(signal);
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw createRequestCanceledError();
}

function validateTimeout(timeoutMs: number, command: string): void {
  if (!Number.isFinite(timeoutMs) || timeoutMs < 0) {
    throw new AppError('INVALID_ARGS', `${command} timeout must be a non-negative number.`);
  }
}

function isRetriableSnapshotError(error: unknown): boolean {
  return error instanceof AppError && error.details?.retriable === true;
}

export function maestroSnapshotSignature(snapshot: SnapshotState): string {
  return createHash('sha256')
    .update(
      JSON.stringify(
        snapshot.nodes.map((node) => ({
          index: node.index,
          parentIndex: node.parentIndex,
          depth: node.depth,
          type: node.type,
          role: node.role,
          subrole: node.subrole,
          identifier: node.identifier,
          label: node.label,
          value: node.value,
          enabled: node.enabled,
          selected: node.selected,
          focused: node.focused,
          visibleToUser: node.visibleToUser,
          hittable: node.hittable,
          pid: node.pid,
          bundleId: node.bundleId,
          appName: node.appName,
          windowTitle: node.windowTitle,
          surface: node.surface,
          hiddenContentAbove: node.hiddenContentAbove,
          hiddenContentBelow: node.hiddenContentBelow,
          interactionBlocked: node.interactionBlocked,
          presentationHints: node.presentationHints,
          rect: node.rect,
        })),
      ),
    )
    .digest('hex');
}

function requireObservationResult(match: MaestroTargetMatch | undefined): MaestroTargetMatch {
  if (match) return match;
  throw new AppError('COMMAND_FAILED', 'Maestro observation completed without a snapshot result.');
}
