import type { MaestroObservationRequest, MaestroRuntimeRequest } from './engine-types.ts';
import type { MaestroCommand } from './program-ir.ts';
import type {
  MaestroRuntimeOperationContext,
  MaestroRuntimeReadContext,
} from './runtime-port-types.ts';

export function operationContext(
  request: MaestroRuntimeRequest,
  command?: Pick<MaestroCommand, 'source'>,
): MaestroRuntimeOperationContext {
  return {
    ...(request.appId === undefined ? {} : { appId: request.appId }),
    env: request.env,
    generation: request.generation,
    invalidateObservation: request.invalidateObservation,
    ...(command ? { source: command.source } : {}),
    ...(request.cachedObservation ? { cachedObservation: request.cachedObservation } : {}),
    ...(request.signal ? { signal: request.signal } : {}),
  };
}

export function observationContext(request: MaestroObservationRequest): MaestroRuntimeReadContext {
  return {
    env: request.env,
    generation: request.generation,
    ...(request.cachedObservation ? { cachedObservation: request.cachedObservation } : {}),
    ...(request.signal ? { signal: request.signal } : {}),
  };
}
