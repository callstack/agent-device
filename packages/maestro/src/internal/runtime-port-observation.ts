import { AppError } from '@agent-device/kernel/errors';
import { maestroTestFailure } from './compatibility-errors.ts';
import type {
  MaestroObservation,
  MaestroObservationCondition,
  MaestroObservationRequest,
  MaestroRuntimeRequest,
} from './engine-types.ts';
import type { MaestroSelector } from './program-ir.ts';
import { observationContext, operationContext } from './runtime-port-context.ts';
import type {
  MaestroRuntimeOperations,
  MaestroSelectorEvidence,
  MaestroTargetMatch,
  MaestroTargetQuery,
  MaestroTargetResolution,
} from './runtime-port-types.ts';

export async function observeMaestroCondition(
  request: MaestroObservationRequest,
  operations: MaestroRuntimeOperations,
): Promise<MaestroObservation> {
  const match = validateTargetMatch(
    await operations.observe(
      { condition: request.condition, timeoutMs: request.timeoutMs },
      observationContext(request),
    ),
    request.generation,
  );
  const evidence: MaestroSelectorEvidence = {
    kind: 'selector',
    selector: request.condition.selector,
    visible: match.visible,
    candidateCount: match.candidateCount,
    ...(match.ref ? { ref: match.ref } : {}),
  };
  return {
    generation: request.generation,
    matched: maestroObservationMatches(request.condition, match),
    candidateCount: match.candidateCount,
    evidence,
  };
}

export function maestroObservationMatches(
  condition: MaestroObservationCondition,
  match: Pick<MaestroTargetMatch, 'matched' | 'visible' | 'failureReason'>,
): boolean {
  // A typed failure reason means no element was selected (for example an
  // out-of-range `index` over matches that are otherwise visible), so the
  // observed selector holds only when a target actually resolved.
  const holds = match.matched && match.visible && match.failureReason === undefined;
  return condition.kind === 'visible' ? holds : !holds;
}

export async function resolveMaestroTarget(
  selector: MaestroSelector,
  query: Pick<MaestroTargetQuery, 'purpose' | 'timeoutMs'>,
  request: MaestroRuntimeRequest,
  operations: MaestroRuntimeOperations,
): Promise<MaestroTargetResolution> {
  const match = await operations.resolveTarget(
    { selector, ...query },
    operationContext(request, request.command),
  );
  const validated = validateTargetMatch(match, request.generation);
  if (!validated.matched || !validated.visible || !validated.rect) {
    throw maestroTestFailure(maestroTargetFailureMessage(selector, validated), {
      selector,
      candidateCount: validated.candidateCount,
      ...(validated.failureReason ? { targetFailureReason: validated.failureReason } : {}),
    });
  }
  return {
    kind: 'selector',
    selector,
    query: { selector, ...query },
    ...validated,
    rect: validated.rect,
  };
}

export function observationForTarget(target: MaestroTargetResolution): MaestroObservation {
  const evidence: MaestroSelectorEvidence = {
    kind: 'selector',
    selector: target.selector,
    visible: target.visible,
    candidateCount: target.candidateCount,
    ...(target.ref ? { ref: target.ref } : {}),
  };
  return {
    generation: target.generation,
    matched: target.matched && target.visible,
    candidateCount: target.candidateCount,
    evidence,
  };
}

function maestroTargetFailureMessage(selector: MaestroSelector, match: MaestroTargetMatch): string {
  const selectorText = formatMaestroSelector(selector);
  switch (match.failureReason) {
    case 'selector-did-not-match':
      return `Maestro target ${selectorText} did not match any element.`;
    case 'no-visible-match':
      return `Maestro target ${selectorText} matched ${match.candidateCount} element(s), but none were visible.`;
    case 'index-out-of-range':
      return `Maestro target ${selectorText} matched ${match.candidateCount} element(s); its index is out of range.`;
    case 'no-usable-geometry':
      return `Maestro target ${selectorText} did not provide usable geometry.`;
    default:
      return 'Maestro target did not resolve to a visible element.';
  }
}

function formatMaestroSelector(selector: MaestroSelector): string {
  const entries = Object.entries(selector).filter(([, value]) => value !== undefined);
  if (entries.length === 0) return 'selector';
  return entries.map(([key, value]) => `"${key}":${JSON.stringify(value)}`).join(', ');
}

function isRect(value: unknown): value is { x: number; y: number; width: number; height: number } {
  if (!value || typeof value !== 'object') return false;
  const rect = value as Record<string, unknown>;
  return ['x', 'y', 'width', 'height'].every(
    (key) => typeof rect[key] === 'number' && Number.isFinite(rect[key]),
  );
}

function validateTargetMatch(match: MaestroTargetMatch, generation: number): MaestroTargetMatch {
  assertMatchingGeneration(match, generation);
  assertValidCandidateCount(match);
  assertValidGeometry(match);
  assertValidSurfaceSignature(match);
  return match;
}

function assertMatchingGeneration(match: MaestroTargetMatch, generation: number): void {
  if (match.generation !== generation) {
    throw new AppError(
      'COMMAND_FAILED',
      `Maestro target evidence generation ${match.generation} does not match ${generation}.`,
    );
  }
}

function assertValidCandidateCount(match: MaestroTargetMatch): void {
  if (!Number.isInteger(match.candidateCount) || match.candidateCount < 0) {
    throw new AppError('COMMAND_FAILED', 'Maestro target evidence has an invalid candidate count.');
  }
}

function assertValidGeometry(match: MaestroTargetMatch): void {
  if (
    (match.rect !== undefined && !isRect(match.rect)) ||
    (match.viewport !== undefined && !isRect(match.viewport))
  ) {
    throw new AppError('COMMAND_FAILED', 'Maestro target evidence has invalid geometry.');
  }
}

function assertValidSurfaceSignature(match: MaestroTargetMatch): void {
  if (match.surfaceSignature !== undefined && typeof match.surfaceSignature !== 'string') {
    throw new AppError(
      'COMMAND_FAILED',
      'Maestro target evidence has an invalid surface signature.',
    );
  }
}
