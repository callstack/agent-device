import {
  checkIsPredicate,
  evaluateIsPredicate,
  formatSelectorFailure,
  IS_TEXT_VALUE_REQUIRED_MESSAGE,
  readSelectorAlternatives,
  selectorFailureHint,
  type IsPredicate,
} from '@agent-device/selectors';
import { resolveSelectorPipeline } from '../../../core/selector-pipeline.ts';
import { SELECTOR_PIPELINE_POLICIES } from '../../../core/selector-pipeline-policy.ts';
import type { SnapshotNode } from '@agent-device/kernel/snapshot';
import type { AgentDeviceRuntime, CommandContext } from '../../../runtime-contract.ts';
import { AppError, isRequestCanceledError } from '@agent-device/kernel/errors';
import type { SelectorTarget } from '@agent-device/contracts/interaction';
import { INTERACTION_ERROR_REASONS } from '@agent-device/contracts/interaction-error';
import type { RuntimeCommand } from '../../runtime-types.ts';
import { assertExpectedResolvedTarget, type ExpectedResolvedTarget } from './resolution.ts';
import {
  type CapturedSnapshot,
  type SelectorSnapshotOptions,
  captureSelectorSnapshot,
} from './selector-read-shared.ts';
import { deriveSelectorCapturePolicy } from './selector-capture-policy.ts';
import { absenceCaptureOptionRefusal } from '../../../core/absence-observation.ts';
import {
  absenceCaptureOptionError,
  absenceUnreadableError,
} from '../../../core/absence-observation-errors.ts';
import { resolveAbsenceObservation } from '../../../core/absence-observation-resolution.ts';

export type IsCommandOptions = CommandContext &
  SelectorSnapshotOptions & {
    predicate: IsPredicate;
    selector: string;
    expectedText?: string;
    /** ADR 0012 step 4: replay-only post-resolution guard; see resolution.ts. */
    expectedResolvedTarget?: ExpectedResolvedTarget;
  };

export type IsCommandResult = {
  predicate: IsCommandOptions['predicate'];
  pass: true;
  selector: string;
  matches?: number;
  text?: string;
  selectorChain?: string[];
  /** ADR 0012 decision 3 / #1349: the resolved node and its tree, for record-time evidence (absent for presence-only predicates). */
  node?: SnapshotNode;
  preActionNodes?: SnapshotNode[];
};

export type IsSelectorCommandOptions = CommandContext &
  SelectorSnapshotOptions & {
    target: SelectorTarget;
  };

export const isCommand: RuntimeCommand<IsCommandOptions, IsCommandResult> = async (
  runtime,
  options,
): Promise<IsCommandResult> => {
  const admitted = checkIsPredicate(options.predicate);
  if (!admitted.ok) throw new AppError(admitted.code, admitted.message, { hint: admitted.hint });
  const predicate = admitted.predicate;
  if (predicate === 'absent') {
    const refusedOption = absenceCaptureOptionRefusal(options);
    if (refusedOption) {
      throw absenceCaptureOptionError(refusedOption);
    }
  }
  if (predicate === 'text' && !options.expectedText) {
    throw new AppError('INVALID_ARGS', IS_TEXT_VALUE_REQUIRED_MESSAGE);
  }
  const selectorExpression = options.selector;
  const capture = await captureIsSnapshot(runtime, options, predicate, selectorExpression);
  if (predicate === 'exists')
    return await resolveExistsPredicate(runtime, capture, selectorExpression);
  if (predicate === 'absent') {
    return await resolveAbsenceObservation(
      capture.snapshot,
      selectorExpression,
      runtime.backend.platform,
    );
  }
  return await resolveAssertedPredicate(runtime, options, capture, predicate, selectorExpression);
};

async function captureIsSnapshot(
  runtime: AgentDeviceRuntime,
  options: IsCommandOptions,
  predicate: IsPredicate,
  selectorExpression: string,
): Promise<CapturedSnapshot> {
  try {
    return await captureSelectorSnapshot(runtime, options, {
      updateSession: true,
      ...deriveSelectorCapturePolicy(predicate),
    });
  } catch (error) {
    if (predicate !== 'absent' || isRequestCanceledError(error)) throw error;
    throw absenceUnreadableError(selectorExpression, error);
  }
}

async function resolveExistsPredicate(
  runtime: AgentDeviceRuntime,
  capture: CapturedSnapshot,
  selectorExpression: string,
): Promise<IsCommandResult> {
  const matched = await resolveSelectorPipeline(
    SELECTOR_PIPELINE_POLICIES.readAny,
    capture.snapshot.nodes,
    selectorExpression,
    { platform: runtime.backend.platform },
  );
  if (matched.kind !== 'target') {
    throw new AppError(
      'COMMAND_FAILED',
      formatSelectorFailure(selectorExpression, [], { unique: false }),
      {
        hint: selectorFailureHint([]),
      },
    );
  }
  return {
    predicate: 'exists',
    pass: true,
    selector: matched.selector,
    matches: matched.matches,
    selectorChain: readSelectorAlternatives(selectorExpression),
  };
}

async function resolveAssertedPredicate(
  runtime: AgentDeviceRuntime,
  options: IsCommandOptions,
  capture: CapturedSnapshot,
  predicate: Exclude<IsPredicate, 'exists' | 'absent'>,
  selectorExpression: string,
): Promise<IsCommandResult> {
  const outcome = await resolveSelectorPipeline(
    SELECTOR_PIPELINE_POLICIES.readUnique,
    capture.snapshot.nodes,
    selectorExpression,
    { platform: runtime.backend.platform },
    {
      onResolved: (node, nodes) =>
        assertExpectedResolvedTarget(node, nodes, options.expectedResolvedTarget, 'is'),
    },
  );
  if (outcome.kind !== 'target') {
    throw new AppError(
      'COMMAND_FAILED',
      formatSelectorFailure(selectorExpression, [], { unique: true }),
      {
        command: 'is',
        reason: INTERACTION_ERROR_REASONS.selectorNotFound,
        predicate: predicate,
        selector: selectorExpression,
        hint: selectorFailureHint([]),
      },
    );
  }
  const result = evaluateIsPredicate({
    predicate,
    node: outcome.node,
    nodes: capture.snapshot.nodes,
    expectedText: options.expectedText,
    platform: runtime.backend.platform,
  });
  if (!result.pass) {
    throw new AppError(
      'COMMAND_FAILED',
      `is ${predicate} failed for selector ${outcome.selector}: ${result.details}`,
      {
        command: 'is',
        reason: INTERACTION_ERROR_REASONS.predicateFailed,
        predicate: predicate,
        selector: outcome.selector,
        predicateDetails: result.details,
      },
    );
  }
  return {
    predicate,
    pass: true,
    selector: outcome.selector,
    ...(predicate === 'text' ? { text: result.actualText } : {}),
    selectorChain: readSelectorAlternatives(selectorExpression),
    node: outcome.node,
    preActionNodes: capture.snapshot.nodes,
  };
}

export const isVisibleCommand: RuntimeCommand<IsSelectorCommandOptions, IsCommandResult> = async (
  runtime,
  options,
): Promise<IsCommandResult> =>
  await isCommand(runtime, {
    ...options,
    predicate: 'visible',
    selector: options.target.selector,
  });

export const isHiddenCommand: RuntimeCommand<IsSelectorCommandOptions, IsCommandResult> = async (
  runtime,
  options,
): Promise<IsCommandResult> =>
  await isCommand(runtime, {
    ...options,
    predicate: 'hidden',
    selector: options.target.selector,
  });
