import { AppError } from '../../kernel/errors.ts';
import type {
  MaestroObservation,
  MaestroObservationCondition,
  MaestroRuntimeRequest,
} from './engine-types.ts';
import type { MaestroSelector } from './program-ir.ts';
import { operationContext } from './runtime-port-context.ts';
import type {
  MaestroRuntimeOperations,
  MaestroSelectorEvidence,
  MaestroTargetMatch,
  MaestroTargetQuery,
  MaestroTargetResolution,
} from './runtime-port-types.ts';

export async function observeMaestroCondition(
  request: {
    condition: MaestroObservationCondition;
    timeoutMs: number;
    generation: number;
    cachedObservation?: MaestroObservation;
    signal?: AbortSignal;
  },
  operations: MaestroRuntimeOperations,
): Promise<MaestroObservation> {
  const match = validateTargetMatch(
    await operations.observe(
      { condition: request.condition, timeoutMs: request.timeoutMs },
      operationContext(request),
    ),
    request.generation,
  );
  const evidence: MaestroSelectorEvidence = {
    kind: 'selector',
    selector: request.condition.selector,
    visible: match.visible,
    ...(match.rect ? { frame: match.rect } : {}),
    candidateCount: match.candidateCount,
    ...(match.ref ? { ref: match.ref } : {}),
  };
  return {
    generation: request.generation,
    matched:
      request.condition.kind === 'visible'
        ? match.matched && match.visible
        : !match.matched || !match.visible,
    candidateCount: match.candidateCount,
    evidence,
  };
}

export function resolveMaestroTarget(
  selector: MaestroSelector,
  query: Pick<MaestroTargetQuery, 'purpose' | 'index' | 'childOf'>,
  request: MaestroRuntimeRequest,
  operations: MaestroRuntimeOperations,
  optional: true,
): Promise<MaestroTargetResolution | undefined>;
export function resolveMaestroTarget(
  selector: MaestroSelector,
  query: Pick<MaestroTargetQuery, 'purpose' | 'index' | 'childOf'>,
  request: MaestroRuntimeRequest,
  operations: MaestroRuntimeOperations,
  optional?: false,
): Promise<MaestroTargetResolution>;
export async function resolveMaestroTarget(
  selector: MaestroSelector,
  query: Pick<MaestroTargetQuery, 'purpose' | 'index' | 'childOf'>,
  request: MaestroRuntimeRequest,
  operations: MaestroRuntimeOperations,
  optional = false,
): Promise<MaestroTargetResolution | undefined> {
  const match = await operations.resolveTarget(
    { selector, ...query },
    operationContext(request, request.command),
  );
  const validated = validateTargetMatch(match, request.generation);
  if (!validated.matched || !validated.visible || !validated.rect) {
    if (optional) return undefined;
    throw new AppError('COMMAND_FAILED', 'Maestro target did not resolve to a visible element.', {
      selector,
      candidateCount: validated.candidateCount,
    });
  }
  return {
    kind: 'selector',
    selector,
    ...validated,
    rect: validated.rect,
  };
}

export function observationForTarget(target: MaestroTargetResolution): MaestroObservation {
  const evidence: MaestroSelectorEvidence = {
    kind: 'selector',
    selector: target.selector,
    visible: target.visible,
    frame: target.rect,
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

function isRect(value: unknown): value is { x: number; y: number; width: number; height: number } {
  if (!value || typeof value !== 'object') return false;
  const rect = value as Record<string, unknown>;
  return ['x', 'y', 'width', 'height'].every(
    (key) => typeof rect[key] === 'number' && Number.isFinite(rect[key]),
  );
}

export function validateTargetMatch(
  match: MaestroTargetMatch,
  generation: number,
): MaestroTargetMatch {
  if (match.generation !== generation) {
    throw new AppError(
      'COMMAND_FAILED',
      `Maestro target evidence generation ${match.generation} does not match ${generation}.`,
    );
  }
  if (!Number.isInteger(match.candidateCount) || match.candidateCount < 0) {
    throw new AppError('COMMAND_FAILED', 'Maestro target evidence has an invalid candidate count.');
  }
  if (
    (match.rect !== undefined && !isRect(match.rect)) ||
    (match.viewport !== undefined && !isRect(match.viewport))
  ) {
    throw new AppError('COMMAND_FAILED', 'Maestro target evidence has invalid geometry.');
  }
  return match;
}
