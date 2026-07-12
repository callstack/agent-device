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

export async function resolveMaestroTarget(
  selector: MaestroSelector,
  query: Pick<MaestroTargetQuery, 'index' | 'childOf'>,
  request: MaestroRuntimeRequest,
  operations: MaestroRuntimeOperations,
): Promise<MaestroTargetResolution> {
  const cached = readCachedTarget(request.cachedObservation, selector, request.generation, query);
  const match =
    cached ??
    (await operations.resolveTarget(
      { selector, ...query },
      operationContext(request, request.command),
    ));
  const validated = validateTargetMatch(match, request.generation);
  if (!validated.matched || !validated.visible || !validated.rect) {
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

function readCachedTarget(
  observation: MaestroObservation | undefined,
  selector: MaestroSelector,
  generation: number,
  query: Pick<MaestroTargetQuery, 'index' | 'childOf'>,
): MaestroTargetMatch | undefined {
  if (query.index !== undefined || query.childOf !== undefined) return undefined;
  if (!observation || observation.generation !== generation) return undefined;
  const evidence = observation.evidence;
  if (!evidence) return undefined;
  if (!selectorsEqual(evidence.selector, selector) || !observation.matched || !evidence.visible) {
    return undefined;
  }
  return {
    generation,
    matched: observation.matched,
    visible: evidence.visible,
    candidateCount: evidence.candidateCount,
    ...(evidence.frame ? { rect: evidence.frame } : {}),
    ...(evidence.ref ? { ref: evidence.ref } : {}),
  };
}

function isRect(value: unknown): value is { x: number; y: number; width: number; height: number } {
  if (!value || typeof value !== 'object') return false;
  const rect = value as Record<string, unknown>;
  return ['x', 'y', 'width', 'height'].every(
    (key) => typeof rect[key] === 'number' && Number.isFinite(rect[key]),
  );
}

function selectorsEqual(left: MaestroSelector, right: MaestroSelector): boolean {
  return (
    left.text === right.text &&
    left.id === right.id &&
    left.label === right.label &&
    left.enabled === right.enabled &&
    left.selected === right.selected
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
