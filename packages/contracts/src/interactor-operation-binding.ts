import type { DeviceInfo } from '@agent-device/kernel/device';
import { AppError } from '@agent-device/kernel/errors';
import type { Interactor, RunnerContext } from './interactor-types.ts';

/**
 * The two ways an interactor-backed operation reaches its mechanics, shared by every binder that
 * rides the `Interactor` seam (screenshot, focus, type, element-text). Each operation module owns
 * its input/result contract; what they must NOT each own is a private copy of interactor
 * resolution — that is duplication of mechanism, and the provider fail-closed rule below must be
 * one rule, not one per operation.
 */
export type LocalInteractorOperationResolver = (
  device: DeviceInfo,
  runner: RunnerContext,
) => Promise<Interactor>;

export type ProviderInteractorOperationResolver = (runner: RunnerContext) => Interactor | undefined;

/**
 * Optional `Interactor` members (keyboard, hover, the hardware buttons only some owners carry)
 * are left undefined by a platform with no such concept. Facts admit an operation only for owners
 * whose interactor implements it, so a missing method at bind time is a runtime-contract error,
 * not a normal refusal — and never a no-op that reports success.
 */
export function requireInteractorMethod<Method>(
  method: Method | undefined,
  operation: string,
): NonNullable<Method> {
  if (method) return method as NonNullable<Method>;
  throw new AppError(
    'COMMAND_FAILED',
    `${operation} was admitted but its bound interactor has no implementation.`,
    { reason: 'interactor-method-missing' },
  );
}

/** Resolves the already-selected local owner's interactor for one bound operation. */
export function localInteractorSource(
  params: Readonly<{ device: DeviceInfo; resolveInteractor: LocalInteractorOperationResolver }>,
): (runner: RunnerContext) => Promise<Interactor> {
  return async (runner) => await params.resolveInteractor(params.device, runner);
}

/**
 * Resolves a provider's own interactor for one bound operation, failing closed when the exact
 * owner no longer exposes it: facts advertised the operation, so a missing interactor is an
 * ownership bug to surface, never a refusal to degrade around.
 */
export function providerInteractorSource(
  params: Readonly<{
    device: DeviceInfo;
    operation: string;
    resolveInteractor: ProviderInteractorOperationResolver;
  }>,
): (runner: RunnerContext) => Promise<Interactor> {
  return async (runner) => {
    const interactor = params.resolveInteractor(runner);
    if (interactor) return interactor;
    throw new AppError(
      'UNSUPPORTED_OPERATION',
      `Provider-owned ${params.operation} operation has no bound provider interactor.`,
      { reason: 'provider-runtime-interactor-missing', deviceId: params.device.id },
    );
  };
}
