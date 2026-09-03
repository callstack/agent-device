import { WAIT_REASONS } from '@agent-device/contracts/wait';
import { isUnreadableCaptureContentError } from '@agent-device/contracts/android-snapshot-quality';
import { AppError } from '@agent-device/kernel/errors';
import {
  absenceCaptureOptionRefusal,
  type AbsenceObservation,
} from '../../../core/absence-observation.ts';
import {
  absenceCaptureOptionError,
  absenceObservationError,
  absenceUnreadableError,
} from '../../../core/absence-observation-errors.ts';
import { SELECTOR_PIPELINE_POLICIES } from '../../../core/selector-pipeline-policy.ts';
import { resolveAbsenceObservationState } from '../../../core/absence-observation-resolution.ts';
import { deriveSelectorCapturePolicy } from './selector-capture-policy.ts';
import type {
  SelectorWaitOperations,
  SelectorWaitRuntime,
  WaitCommandOptions,
  WaitCommandResult,
} from './selector-wait.ts';
import {
  createWaitPolling,
  type WaitFailureEvidence,
  waitTimeoutError,
  type WaitPollDeadline,
} from './wait-polling.ts';

type PresentObservation = Extract<AbsenceObservation, { kind: 'present' }>;

export async function waitForAbsent<Runtime extends SelectorWaitRuntime>(
  operations: SelectorWaitOperations<Runtime>,
  runtime: Runtime,
  options: WaitCommandOptions,
  selectorExpression: string,
  timeoutMs: number | null | undefined,
): Promise<Extract<WaitCommandResult, { kind: 'absent' }>> {
  const refusedOption = absenceCaptureOptionRefusal(options);
  if (refusedOption) throw absenceCaptureOptionError(refusedOption, 'wait');

  const polling = createWaitPolling(runtime, options, timeoutMs, SELECTOR_PIPELINE_POLICIES.wait, {
    isUnreadableError: isWaitAbsentUnreadableError,
    preserveUnreadableOnStall: true,
  });
  const capturePolicy = deriveSelectorCapturePolicy();
  let present: PresentObservation | undefined;
  let deadline: WaitPollDeadline | undefined;

  while (polling.hasTimeRemaining()) {
    const poll = await polling.capture(async (signal) => {
      try {
        const capture = await operations.captureSnapshot(
          runtime,
          { ...options, signal },
          {
            updateSession: true,
            includeHiddenContentHints: false,
            ...capturePolicy,
          },
        );
        const { observation } = await resolveAbsenceObservationState(
          capture.snapshot,
          selectorExpression,
          runtime.backend.platform,
        );
        if (observation.kind === 'sparse' || observation.kind === 'truncated') {
          throw absenceObservationError(selectorExpression, observation, 'wait');
        }
        return observation;
      } catch (error) {
        if (isUnreadableCaptureContentError(error)) {
          throw absenceUnreadableError(selectorExpression, error, 'wait');
        }
        throw error;
      }
    });

    if (poll.timedOut) {
      deadline = poll.deadline;
      break;
    }
    const observation = poll.value;
    if (observation?.kind === 'absent') {
      return { kind: 'absent', waitedMs: polling.waitedMs() };
    }
    if (observation?.kind === 'present') present = observation;
    await polling.sleepUntilNextPoll();
  }

  // A runner restart is the authoritative deadline cause even when an earlier
  // readable poll saw the target. Returning stale target-present evidence would
  // hide the retriable restart and make callers stop retrying the wrong reason.
  if (deadline === 'runner-restart-exhausted') {
    throw waitTimeoutError(
      `wait absent timed out for selector: ${selectorExpression}`,
      polling,
      deadline,
    );
  }
  if (present) throw waitTargetPresentError(selectorExpression, present, polling.failureEvidence());
  throw waitTimeoutError(
    `wait absent timed out for selector: ${selectorExpression}`,
    polling,
    deadline,
  );
}

function waitTargetPresentError(
  selector: string,
  observation: PresentObservation,
  evidence: WaitFailureEvidence,
): AppError {
  const multiple = observation.matches !== 1;
  return new AppError(
    'COMMAND_FAILED',
    `wait absent timed out for selector ${selector}: ${observation.matches} match${multiple ? 'es' : ''} remain`,
    {
      reason: WAIT_REASONS.targetPresent,
      selector,
      ...evidence,
      matches: observation.matches,
      firstMatch: observation.firstMatch,
    },
  );
}

function isWaitAbsentUnreadableError(error: unknown): boolean {
  if (!(error instanceof AppError)) return false;
  const details = error.details;
  return (
    details?.command === 'wait' &&
    details.predicate === 'absent' &&
    (details.observation === 'sparse' ||
      details.observation === 'truncated' ||
      details.observation === 'unreadable')
  );
}
