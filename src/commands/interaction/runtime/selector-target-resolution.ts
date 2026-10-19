import type { AppError } from '@agent-device/kernel/errors';
import type { SnapshotState } from '@agent-device/kernel/snapshot';
import { inheritPostGestureOutcome } from '@agent-device/kernel/snapshot';
import { resolveSelectorPipeline } from '@agent-device/selectors/selector-pipeline';
import { SELECTOR_PIPELINE_POLICIES } from '@agent-device/selectors/selector-pipeline-policy';
import type { AgentDeviceRuntime, CommandContext } from '@agent-device/contracts/runtime-contract';
import {
  captureInteractionSnapshot,
  type InteractionSnapshot,
} from './interaction-snapshot-capture.ts';
import { buildCoveredInteractionError } from './target-visibility-stages.ts';
import {
  resolveActionSelector,
  type ActionSelectorResolution,
} from './selector-action-resolution.ts';
import { selectorNotFoundFailure } from './selector-read-shared.ts';
import type { InteractionAction } from '@agent-device/selectors/interaction-action';
import type { ResolveInteractionTargetParams } from './interaction-resolution-request.ts';

export type SelectorResolutionAttempt = {
  capture: InteractionSnapshot;
  resolved: ActionSelectorResolution | null;
};

export async function attemptSelectorResolution(
  runtime: AgentDeviceRuntime,
  options: CommandContext,
  selectorExpression: string,
  params: ResolveInteractionTargetParams,
): Promise<SelectorResolutionAttempt> {
  let capture = await captureInteractionSnapshot(runtime, options, params.requireInteractive);
  let resolved = resolveActionSelector(
    capture.snapshot.nodes,
    selectorExpression,
    runtime.backend.platform,
    params.pipeline,
  );
  if ((!resolved || !resolved.node.rect) && params.requireInteractive) {
    const interactive = capture.snapshot;
    capture = await captureInteractionSnapshot(runtime, options, false);
    inheritPostGestureOutcome(interactive, capture.snapshot);
    resolved = resolveActionSelector(
      capture.snapshot.nodes,
      selectorExpression,
      runtime.backend.platform,
      params.pipeline,
    );
  }
  return { capture, resolved };
}

async function detectCoveredSelectorTarget(params: {
  runtime: AgentDeviceRuntime;
  nodes: SnapshotState['nodes'];
  selectorExpression: string;
  action: InteractionAction;
}): Promise<AppError | undefined> {
  const { runtime, nodes, selectorExpression, action } = params;
  const covered = await resolveSelectorPipeline(
    SELECTOR_PIPELINE_POLICIES.coveredDiagnosis,
    nodes,
    selectorExpression,
    { platform: runtime.backend.platform },
  );
  if (covered.kind !== 'occluded') return undefined;
  return buildCoveredInteractionError({
    label: `Selector ${covered.selector}`,
    node: covered.node,
    action,
    selector: covered.selector,
  });
}

export async function selectorInteractionFailure(params: {
  runtime: AgentDeviceRuntime;
  nodes: SnapshotState['nodes'];
  selectorExpression: string;
  action: InteractionAction;
  resolved: ActionSelectorResolution | null;
}): Promise<AppError> {
  const { runtime, nodes, selectorExpression, action, resolved } = params;
  const covered = await detectCoveredSelectorTarget({ runtime, nodes, selectorExpression, action });
  if (covered) return covered;
  return selectorNotFoundFailure(selectorExpression, {
    diagnostics: resolved?.diagnostics ?? [],
    unique: true,
    dispatched: 'no',
  });
}
