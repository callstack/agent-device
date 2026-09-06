import type {
  RuntimeUseStep,
  RuntimeUseStepSelector,
} from '@agent-device/contracts/command-platform-execution';
import {
  findRuntimeIntent,
  findRuntimePlanUses,
  resolveSelectorCaptureRuntimePlan,
  resolveSnapshotRuntimePlan,
} from '@agent-device/contracts/platform-runtime-operations';
import { checkFindArgs, isReadOnlyFindAction, type FindAction } from '@agent-device/selectors';

/**
 * Plan-time selectors for the commands whose declared alternatives differ in what they execute.
 * Each reads the daemon step exactly as its handler will (`flags` and `positionals`; a structured
 * `input` only when a caller kept one) and resolves the same plan the handler resolves, for both
 * sides of the active-app split the plan cannot know yet.
 */
export const selectSnapshotStepUses: RuntimeUseStepSelector = (step) => {
  const customActions =
    step.flags?.['snapshotCustomActions'] === true || step.input?.['customActions'] === true;
  return [true, false].map(
    (hasActiveApp) => resolveSnapshotRuntimePlan({ customActions, hasActiveApp }).use,
  );
};

/**
 * `find` parses its action from positionals and defaults a missing one to click, so a step the
 * handler would not parse as a read-only, focus, or type action keeps every declared alternative
 * (fail closed), including a step whose positionals are not there to parse.
 */
export const selectFindStepUses: RuntimeUseStepSelector = (step) => {
  const action = findStepAction(step);
  if (action === undefined || !plansOwnLeg(action)) return findRuntimePlanUses;
  const intent = findRuntimeIntent(action);
  return [true, false].map(
    (hasActiveApp) => resolveSelectorCaptureRuntimePlan({ hasActiveApp, intent }).use,
  );
};

function plansOwnLeg(action: FindAction['kind']): boolean {
  return isReadOnlyFindAction(action) || action === 'focus' || action === 'type';
}

function findStepAction(step: RuntimeUseStep): FindAction['kind'] | undefined {
  if (step.positionals === undefined) return undefined;
  const checked = checkFindArgs(step.positionals, step.flags);
  return checked.ok ? checked.parsed.action : undefined;
}
