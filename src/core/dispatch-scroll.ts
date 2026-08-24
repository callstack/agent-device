import type { Interactor } from '@agent-device/contracts/interactor-types';
import {
  type ResolvedScrollExecutionOptions,
  type ScrollCommandOptions,
  assertExclusiveScrollDistanceInputs,
  honoredScrollDurationMs,
  normalizeScrollDurationMs,
  resolveScrollExecutionOptions,
} from '@agent-device/contracts/scroll-command';
import { type ScrollDirection, parseScrollDirection } from '@agent-device/contracts/scroll-gesture';
import { AppError } from '@agent-device/kernel/errors';
import {
  captureScrollEdgeState,
  formatScrollEdgeMessage,
  runScrollEdgePasses,
  type ScrollEdge,
  type ScrollEdgeState,
} from '../utils/scroll-edge-state.ts';
import { withSuccessText } from '../utils/success-text.ts';
import type { DispatchContext } from './dispatch-context.ts';

type ScrollTarget = { direction: ScrollDirection; edge?: ScrollEdge };

export async function handleScrollCommand(
  interactor: Interactor,
  positionals: string[],
  context: DispatchContext | undefined,
): Promise<Record<string, unknown>> {
  const directionInput = positionals[0];
  const amount = positionals[1] ? Number(positionals[1]) : undefined;
  const pixels = context?.pixels;
  const durationMs = context?.durationMs;
  if (!directionInput) throw new AppError('INVALID_ARGS', 'scroll requires direction');
  assertScrollCommandInputs(amount, pixels, durationMs);

  const target = parseScrollTarget(directionInput);
  const options = resolveScrollExecutionOptions({ amount, pixels, durationMs }, target.edge);
  const { interactionResult, completedPasses } = await runDispatchedScroll(
    interactor,
    context,
    target,
    options,
  );
  const result = buildDispatchedScrollResult(target, options, completedPasses, interactionResult);
  return withSuccessText(
    result,
    formatScrollEdgeMessage(target.direction, target.edge, completedPasses, amount, pixels),
  );
}

function assertScrollCommandInputs(
  amount: number | undefined,
  pixels: number | undefined,
  durationMs: number | undefined,
): void {
  if (amount !== undefined && !Number.isFinite(amount)) {
    throw new AppError('INVALID_ARGS', 'scroll amount must be a number');
  }
  normalizeScrollDurationMs(durationMs);
  assertExclusiveScrollDistanceInputs({ amount, pixels });
}

async function runDispatchedScroll(
  interactor: Interactor,
  context: DispatchContext | undefined,
  target: ScrollTarget,
  options: ResolvedScrollExecutionOptions,
): Promise<{ interactionResult: Record<string, unknown>; completedPasses: number }> {
  if (target.edge) {
    const edgeResult = await runScrollEdgePasses({
      edge: target.edge,
      captureState: async (scope) =>
        await captureVerifiedScrollEdgeState(interactor, context, target.edge!, scope),
      scroll: async () => await interactor.scroll(target.direction, options),
    });
    return { interactionResult: edgeResult.result ?? {}, completedPasses: edgeResult.passes };
  }
  return {
    interactionResult: (await interactor.scroll(target.direction, options)) ?? {},
    completedPasses: 1,
  };
}

function buildDispatchedScrollResult(
  target: ScrollTarget,
  options: ScrollCommandOptions,
  completedPasses: number,
  interactionResult: Record<string, unknown>,
): Record<string, unknown> {
  const durationMs = honoredScrollDurationMs(interactionResult);
  return {
    direction: target.direction,
    ...(target.edge ? { edge: target.edge, passes: completedPasses } : {}),
    ...(options.amount !== undefined ? { amount: options.amount } : {}),
    ...(options.pixels !== undefined ? { pixels: options.pixels } : {}),
    ...(durationMs !== undefined ? { durationMs } : {}),
    ...interactionResult,
  };
}

async function captureVerifiedScrollEdgeState(
  interactor: Interactor,
  context: DispatchContext | undefined,
  edge: ScrollEdge,
  scope?: string,
): Promise<ScrollEdgeState> {
  if (typeof interactor.snapshot !== 'function') {
    throw new AppError(
      'UNSUPPORTED_OPERATION',
      `scroll ${edge} requires snapshot support to verify hidden content before scrolling`,
    );
  }
  const snapshot = interactor.snapshot;
  return await captureScrollEdgeState({
    edge,
    scope,
    captureNodes: async (snapshotScope) =>
      (
        await snapshot({
          appBundleId: context?.appBundleId,
          scope: snapshotScope,
        })
      ).nodes ?? [],
  });
}

function parseScrollTarget(input: string): ScrollTarget {
  if (input === 'bottom') return { direction: 'down', edge: 'bottom' };
  if (input === 'top') return { direction: 'up', edge: 'top' };
  return { direction: parseScrollDirection(input) };
}
