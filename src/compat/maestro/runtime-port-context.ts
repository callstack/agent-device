import type { MaestroObservationRequest, MaestroRuntimeRequest } from './engine-types.ts';
import { stripUndefined } from '../../utils/parsing.ts';
import type { MaestroCommand } from './program-ir.ts';
import type {
  MaestroRuntimeOperationContext,
  MaestroRuntimeReadContext,
} from './runtime-port-types.ts';

export function operationContext(
  request: MaestroRuntimeRequest,
  command?: Pick<MaestroCommand, 'source'>,
): MaestroRuntimeOperationContext {
  return stripUndefined({
    appId: request.appId,
    env: request.env,
    generation: request.generation,
    invalidateObservation: request.invalidateObservation,
    source: command?.source,
    cachedObservation: request.cachedObservation,
    signal: request.signal,
  });
}

export function observationContext(request: MaestroObservationRequest): MaestroRuntimeReadContext {
  return stripUndefined({
    env: request.env,
    generation: request.generation,
    cachedObservation: request.cachedObservation,
    signal: request.signal,
  });
}
