import type { MaestroRuntimeRequest } from './engine-types.ts';
import type { MaestroCommand } from './program-ir.ts';
import type { MaestroRuntimeOperationContext } from './runtime-port-types.ts';

export function operationContext(
  request: Pick<
    MaestroRuntimeRequest,
    'appId' | 'env' | 'generation' | 'cachedObservation' | 'signal'
  > &
    Partial<Pick<MaestroRuntimeRequest, 'invalidateObservation'>>,
  command?: Pick<MaestroCommand, 'source'>,
): MaestroRuntimeOperationContext {
  return {
    ...(request.appId === undefined ? {} : { appId: request.appId }),
    env: request.env,
    generation: request.generation,
    invalidateObservation: request.invalidateObservation ?? ignoreObservationInvalidation,
    ...(command ? { source: command.source } : {}),
    ...(request.cachedObservation ? { cachedObservation: request.cachedObservation } : {}),
    ...(request.signal ? { signal: request.signal } : {}),
  };
}

function ignoreObservationInvalidation(): void {}
