import { isIosFamily } from '@agent-device/kernel/device';
import type { SnapshotNode } from '@agent-device/kernel/snapshot';
import { isActiveProviderDevice } from './provider-device-admission.ts';
import { isPostGestureStabilizationPending } from './deferred-interaction-outcome.ts';
import type { SessionState } from './session-state.ts';
import { readSimpleSelectorTarget } from '@agent-device/selectors';
import { asAppError, isRequestCanceledError } from '@agent-device/kernel/errors';
import type { ElementSelectorTapOptions } from '@agent-device/contracts/interactor-types';

export type DirectIosSelectorTarget = ElementSelectorTapOptions & { raw: string };

export function isLocalIosRunnerSession(
  session: SessionState | undefined,
  options: { skipPendingPostGestureStabilization: boolean },
): session is SessionState {
  if (!session) return false;
  if (!isIosFamily(session.device)) return false;
  if (isActiveProviderDevice(session.device)) return false;
  if (options.skipPendingPostGestureStabilization && isPostGestureStabilizationPending(session)) {
    return false;
  }
  return true;
}

export function readSimpleIosSelectorTarget(params: {
  session: SessionState | undefined;
  selectorExpression: string;
}): DirectIosSelectorTarget | null {
  const { session, selectorExpression } = params;
  if (!isLocalIosRunnerSession(session, { skipPendingPostGestureStabilization: true })) {
    return null;
  }
  return readSimpleSelectorTarget(selectorExpression);
}

export function deriveDirectIosNodeSelector(
  node: Pick<SnapshotNode, 'identifier' | 'label'>,
): { key: 'id' | 'label'; value: string } | null {
  const identifier = node.identifier?.trim();
  if (identifier) return { key: 'id', value: identifier };
  const label = node.label?.trim();
  if (label) return { key: 'label', value: label };
  return null;
}

/** The runner's selector refusals: it resolved the selector and refused before any gesture. */
const RUNNER_SELECTOR_REFUSAL_CODES: ReadonlySet<string> = new Set([
  'ELEMENT_NOT_FOUND',
  'ELEMENT_OFFSCREEN',
  'AMBIGUOUS_MATCH',
]);

/**
 * Whether a failed direct iOS selector tap may delegate to the tree path, which taps again. Only a
 * failure disclosed `dispatched: no` may: a connect refusal, a pre-send restart or readiness
 * verdict, `RUNNER_BUSY`, or a runner selector refusal. An `unknown` failure may already have
 * tapped. Selector refusals delegate only when `delegateSemanticFailures` is set;
 * Maestro replay keeps their runner-native shapes.
 */
export function isDirectIosSelectorFallbackError(
  error: unknown,
  options: { delegateSemanticFailures: boolean },
): boolean {
  const appError = asAppError(error);
  if (appError.details?.dispatched !== 'no' || isRequestCanceledError(appError)) return false;
  if (RUNNER_SELECTOR_REFUSAL_CODES.has(appError.code)) return options.delegateSemanticFailures;
  return appError.code === 'COMMAND_FAILED';
}
