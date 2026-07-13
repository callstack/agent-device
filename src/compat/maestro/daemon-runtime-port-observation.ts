import { createRequestCanceledError } from '../../request/cancel.ts';
import {
  getSnapshotReferenceFrame,
  type TouchReferenceFrame,
} from '../../daemon/touch-reference-frame.ts';
import { AppError } from '../../kernel/errors.ts';
import type { Rect, SnapshotState } from '../../kernel/snapshot.ts';
import type { MaestroObservation, MaestroObservationCondition } from './engine-types.ts';
import type { MaestroPlatform, MaestroSelector } from './program-ir.ts';
import {
  resolveMaestroTargetFromSnapshot,
  type MaestroMatchResolutionOptions,
  type MaestroPreferredContext,
  type MaestroTargetQuery as SnapshotTargetQuery,
} from './runtime-targets.ts';
import type {
  MaestroRuntimeOperationContext,
  MaestroTargetMatch,
  MaestroTargetQuery,
} from './runtime-port-types.ts';

export const MAESTRO_OBSERVATION_POLL_MS = 250;

export type DaemonMaestroRuntimeDependencies = {
  readonly now: () => number;
  readonly sleep: (milliseconds: number, signal?: AbortSignal) => Promise<void>;
};

export type MaestroSnapshotReader = (
  context: MaestroRuntimeOperationContext,
) => Promise<SnapshotState>;

export type MaestroSnapshotSource = {
  readonly capture: MaestroSnapshotReader;
  readonly bindObservation: (observation: MaestroObservation) => void;
  readonly reuseObservation: (context: MaestroRuntimeOperationContext) => SnapshotState | undefined;
};

export type MaestroTargetResolutionMode = 'tap' | 'swipe' | 'observe';

export async function resolveTypedMaestroTarget(params: {
  readonly query: MaestroTargetQuery;
  readonly context: MaestroRuntimeOperationContext;
  readonly snapshot: SnapshotState;
  readonly platform: Extract<MaestroPlatform, 'ios' | 'android'>;
  readonly preferredContext?: MaestroPreferredContext;
}): Promise<MaestroTargetMatch> {
  return resolveTargetFromSnapshot({
    ...params,
    mode: params.query.purpose === 'swipe' ? 'swipe' : 'tap',
  });
}

export function resolveTypedMaestroPreferredContext(params: {
  readonly selector: MaestroSelector;
  readonly snapshot: SnapshotState;
  readonly platform: Extract<MaestroPlatform, 'ios' | 'android'>;
}): MaestroPreferredContext | undefined {
  const resolution = resolveMaestroTargetFromSnapshot(
    params.snapshot,
    { selector: params.selector },
    params.platform,
    getSnapshotReferenceFrame(params.snapshot),
    resolutionOptions('observe', undefined),
  );
  return resolution.ok ? { node: resolution.node, rect: resolution.rect } : undefined;
}

function resolveTargetFromSnapshot(params: {
  readonly query: SnapshotTargetQuery;
  readonly context: MaestroRuntimeOperationContext;
  readonly snapshot: SnapshotState;
  readonly platform: Extract<MaestroPlatform, 'ios' | 'android'>;
  readonly mode: MaestroTargetResolutionMode;
  readonly preferredContext?: MaestroPreferredContext;
}): MaestroTargetMatch {
  const frame = getSnapshotReferenceFrame(params.snapshot);
  const resolution = resolveMaestroTargetFromSnapshot(
    params.snapshot,
    params.query,
    params.platform,
    frame,
    resolutionOptions(params.mode, params.preferredContext),
  );
  return targetMatchFromResolution(resolution, params.context.generation, frame);
}

export async function observeTypedMaestroCondition(params: {
  readonly condition: MaestroObservationCondition;
  readonly timeoutMs: number;
  readonly context: MaestroRuntimeOperationContext;
  readonly snapshot: MaestroSnapshotReader;
  readonly dependencies: DaemonMaestroRuntimeDependencies;
  readonly platform: Extract<MaestroPlatform, 'ios' | 'android'>;
}): Promise<MaestroTargetMatch> {
  validateTimeout(params.timeoutMs, 'observation');
  let lastMatch: MaestroTargetMatch | undefined;
  const deadline = params.dependencies.now() + params.timeoutMs;

  while (true) {
    throwIfAborted(params.context.signal);
    const captureStartedAt = params.dependencies.now();
    const snapshot = await params.snapshot(params.context);
    const match = resolveTargetFromSnapshot({
      query: { selector: params.condition.selector },
      context: params.context,
      snapshot,
      platform: params.platform,
      mode: 'observe',
    });
    lastMatch = match;
    if (conditionMatches(params.condition, match)) return match;
    if (captureStartedAt >= deadline) break;

    const remaining = deadline - params.dependencies.now();
    if (remaining > 0) {
      await sleepWithinBudget(
        params.dependencies,
        Math.min(MAESTRO_OBSERVATION_POLL_MS, remaining),
        params.context.signal,
      );
    }
  }

  throwIfAborted(params.context.signal);
  return lastMatch ?? unreachableObservationResult(params.context.generation);
}

export async function scrollUntilTypedMaestroTarget(params: {
  readonly selector: MaestroSelector;
  readonly direction: string;
  readonly timeoutMs: number;
  readonly context: MaestroRuntimeOperationContext;
  readonly snapshot: MaestroSnapshotReader;
  readonly scroll: () => Promise<void>;
  readonly dependencies: DaemonMaestroRuntimeDependencies;
  readonly platform: Extract<MaestroPlatform, 'ios' | 'android'>;
}): Promise<MaestroTargetMatch> {
  validateTimeout(params.timeoutMs, 'scrollUntilVisible');
  const deadline = params.dependencies.now() + params.timeoutMs;
  let lastMatch: MaestroTargetMatch | undefined;

  while (true) {
    throwIfAborted(params.context.signal);
    const captureStartedAt = params.dependencies.now();
    const snapshot = await params.snapshot(params.context);
    lastMatch = resolveTargetFromSnapshot({
      query: { selector: params.selector },
      context: params.context,
      snapshot,
      platform: params.platform,
      mode: 'observe',
    });
    if (lastMatch.matched && lastMatch.visible) return lastMatch;
    if (captureStartedAt >= deadline) break;

    const remaining = deadline - params.dependencies.now();
    if (remaining > 0) {
      await params.scroll();
      const afterScroll = deadline - params.dependencies.now();
      if (afterScroll > 0) {
        await sleepWithinBudget(
          params.dependencies,
          Math.min(MAESTRO_OBSERVATION_POLL_MS, afterScroll),
          params.context.signal,
        );
      }
    }
  }

  throwIfAborted(params.context.signal);
  return lastMatch ?? unreachableObservationResult(params.context.generation);
}

export async function waitForTypedSnapshotStability(params: {
  readonly timeoutMs: number;
  readonly context: MaestroRuntimeOperationContext;
  readonly snapshot: MaestroSnapshotReader;
  readonly dependencies: DaemonMaestroRuntimeDependencies;
}): Promise<void> {
  validateTimeout(params.timeoutMs, 'waitForAnimationToEnd');
  const deadline = params.dependencies.now() + params.timeoutMs;
  let previousSignature: string | undefined;

  while (true) {
    throwIfAborted(params.context.signal);
    const captureStartedAt = params.dependencies.now();
    const snapshot = await params.snapshot(params.context);
    const signature = snapshotStabilitySignature(snapshot);
    if (signature === previousSignature) return;
    previousSignature = signature;
    if (captureStartedAt >= deadline) return;

    const remaining = deadline - params.dependencies.now();
    if (remaining > 0) {
      await sleepWithinBudget(
        params.dependencies,
        Math.min(MAESTRO_OBSERVATION_POLL_MS, remaining),
        params.context.signal,
      );
    }
  }
}

export function snapshotViewportRect(frame: TouchReferenceFrame | undefined): Rect | undefined {
  return frame
    ? { x: 0, y: 0, width: frame.referenceWidth, height: frame.referenceHeight }
    : undefined;
}

function resolutionOptions(
  mode: MaestroTargetResolutionMode,
  preferredContext: MaestroPreferredContext | undefined,
): MaestroMatchResolutionOptions {
  return {
    promoteTapTarget: mode === 'tap',
    requireOnScreen: true,
    ...(preferredContext ? { preferredContext } : {}),
  };
}

function targetMatchFromResolution(
  resolution: ReturnType<typeof resolveMaestroTargetFromSnapshot>,
  generation: number,
  frame: TouchReferenceFrame | undefined,
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
  return {
    generation,
    matched: true,
    visible: true,
    candidateCount: resolution.evidence.candidateCount,
    rect: resolution.rect,
    ...(resolution.evidence.ref ? { ref: resolution.evidence.ref } : {}),
    ...(snapshotViewportRect(frame) ? { viewport: snapshotViewportRect(frame) } : {}),
  };
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

function snapshotStabilitySignature(snapshot: SnapshotState): string {
  return JSON.stringify(
    snapshot.nodes.map((node) => ({
      index: node.index,
      parentIndex: node.parentIndex,
      type: node.type,
      identifier: node.identifier,
      label: node.label,
      value: node.value,
      rect: node.rect
        ? {
            x: Math.round(node.rect.x),
            y: Math.round(node.rect.y),
            width: Math.round(node.rect.width),
            height: Math.round(node.rect.height),
          }
        : undefined,
    })),
  );
}

function unreachableObservationResult(generation: number): MaestroTargetMatch {
  return {
    generation,
    matched: false,
    visible: false,
    candidateCount: 0,
  };
}
