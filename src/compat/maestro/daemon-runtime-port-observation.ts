import { createRequestCanceledError } from '../../request/cancel.ts';
import {
  getSnapshotReferenceFrame,
  type TouchReferenceFrame,
} from '../../daemon/touch-reference-frame.ts';
import { AppError } from '../../kernel/errors.ts';
import type { Rect, SnapshotState } from '../../kernel/snapshot.ts';
import type { MaestroObservation, MaestroObservationCondition } from './engine-types.ts';
import type { MaestroPlatform, MaestroSelector } from './program-ir.ts';
import { literalFromMaestroRegex } from './selector-regex.ts';
import {
  resolveMaestroTargetFromSnapshot,
  type MaestroMatchResolutionOptions,
  type MaestroPreferredContext,
  type MaestroTargetQuery as SnapshotTargetQuery,
} from './runtime-targets.ts';
import type {
  MaestroDispatchSelector,
  MaestroRuntimeOperationContext,
  MaestroTargetMatch,
  MaestroTargetQuery,
} from './runtime-port-types.ts';

export const MAESTRO_OBSERVATION_POLL_MS = 250;
// Snapshot transport readiness is distinct from selector matching. A launched app may own the
// foreground activity before it exposes an accessibility surface, especially during a cold start.
export const MAESTRO_INITIAL_SNAPSHOT_READY_TIMEOUT_MS = 30_000;
const MAESTRO_STABILITY_POLL_MS = 200;

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
  readonly invalidate: () => void;
};

export type MaestroTargetResolutionMode = 'tap' | 'swipe' | 'observe';

export async function captureRetriableMaestroSnapshot(
  params: {
    readonly context: MaestroRuntimeOperationContext;
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
  readonly query: SnapshotTargetQuery & { readonly allowAtomicSelectorDispatch?: boolean };
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
  return targetMatchFromResolution(
    resolution,
    params.context.generation,
    frame,
    params.query,
    params.snapshot,
    params.platform,
    params.mode,
  );
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
  const initialSnapshotDeadline =
    params.dependencies.now() + MAESTRO_INITIAL_SNAPSHOT_READY_TIMEOUT_MS;
  let conditionDeadline: number | undefined;

  while (true) {
    throwIfAborted(params.context.signal);
    const captureStartedAt = params.dependencies.now();
    const snapshot = await captureRetriableMaestroSnapshot(
      params,
      conditionDeadline ?? initialSnapshotDeadline,
    );
    conditionDeadline ??= params.dependencies.now() + params.timeoutMs;
    const match = resolveTargetFromSnapshot({
      query: { selector: params.condition.selector },
      context: params.context,
      snapshot,
      platform: params.platform,
      mode: 'observe',
    });
    lastMatch = match;
    if (conditionMatches(params.condition, match)) return match;
    if (captureStartedAt >= conditionDeadline) break;

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
    const snapshot = await captureRetriableMaestroSnapshot(params, deadline);
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
    const snapshot = await captureRetriableMaestroSnapshot(params, deadline);
    const signature = snapshotStabilitySignature(snapshot);
    if (signature === previousSignature) return;
    const hadPreviousSignature = previousSignature !== undefined;
    previousSignature = signature;
    if (captureStartedAt >= deadline) return;

    const remaining = deadline - params.dependencies.now();
    if (hadPreviousSignature && remaining > 0) {
      await sleepWithinBudget(
        params.dependencies,
        Math.min(MAESTRO_STABILITY_POLL_MS, remaining),
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
    allowLeadingCompositeLabelMatch: mode === 'tap',
    requireOnScreen: true,
    ...(preferredContext ? { preferredContext } : {}),
  };
}

function targetMatchFromResolution(
  resolution: ReturnType<typeof resolveMaestroTargetFromSnapshot>,
  generation: number,
  frame: TouchReferenceFrame | undefined,
  query: SnapshotTargetQuery & { allowAtomicSelectorDispatch?: boolean },
  snapshot: SnapshotState,
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
    resolution,
    snapshot,
    platform,
    mode,
  });
  return {
    generation,
    matched: true,
    visible: true,
    candidateCount: resolution.evidence.candidateCount,
    rect: resolution.rect,
    ...(resolution.evidence.ref ? { ref: resolution.evidence.ref } : {}),
    ...(snapshotViewportRect(frame) ? { viewport: snapshotViewportRect(frame) } : {}),
    ...(dispatchSelector ? { dispatchSelector } : {}),
  };
}

function resolveAtomicIosDispatchSelector(params: {
  query: SnapshotTargetQuery & { allowAtomicSelectorDispatch?: boolean };
  resolution: Extract<ReturnType<typeof resolveMaestroTargetFromSnapshot>, { ok: true }>;
  snapshot: SnapshotState;
  platform: Extract<MaestroPlatform, 'ios' | 'android'>;
  mode: MaestroTargetResolutionMode;
}): MaestroDispatchSelector | undefined {
  const { query, resolution, snapshot, platform, mode } = params;
  if (!allowsAtomicIosDispatch(query, platform, mode)) return undefined;
  const selector = singleExactDispatchSelector(query.selector);
  if (!selector) return undefined;

  const exactMatches = snapshot.nodes.filter((node) =>
    runnerSelectorValues(node, selector.key).some((candidate) =>
      equalIgnoringCase(candidate, selector.value),
    ),
  );
  if (exactMatches.length !== 1 || exactMatches[0]?.index !== resolution.node.index) {
    return undefined;
  }
  return selector;
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

function runnerSelectorValues(
  node: SnapshotState['nodes'][number],
  key: MaestroDispatchSelector['key'],
): string[] {
  if (key === 'id') return typeof node.identifier === 'string' ? [node.identifier] : [];
  if (key === 'label') return typeof node.label === 'string' ? [node.label] : [];
  return [node.label, node.identifier, node.value].filter(
    (value): value is string => typeof value === 'string',
  );
}

function equalIgnoringCase(left: string, right: string): boolean {
  return left.toLocaleLowerCase() === right.toLocaleLowerCase();
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

function snapshotStabilitySignature(snapshot: SnapshotState): string {
  return JSON.stringify(
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
