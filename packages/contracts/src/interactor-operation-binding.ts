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
