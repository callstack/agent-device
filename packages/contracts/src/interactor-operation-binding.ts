import type { DeviceInfo } from '@agent-device/kernel/device';
import { AppError } from '@agent-device/kernel/errors';
import type { Interactor, RunnerContext } from './interactor-types.ts';
import type {
  NoArgumentInteractorInput,
  NoArgumentInteractorOperations,
} from './platform-runtime-operations.ts';

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

/**
 * Binds the zero-argument interactor operations group: one fact admits each member, one interactor
 * call performs it, and the only thing that travels is runner metadata. Each entry point supplies
 * its own resolution, so this holds only what they share — the abort check, the runner context, and
 * the call. `home` and `app-switcher` carry the same shape in modules written before the shape had a
 * name; a new member is one entry in `NoArgumentInteractorOperations` and one line here, plus its
 * catalog row, rather than another module and export subpath.
 */
export function bindNoArgumentInteractorOperations(
  signal: AbortSignal,
  resolveInteractor: (runner: RunnerContext) => Promise<Interactor>,
): NoArgumentInteractorOperations {
  return Object.freeze({
    actionButton: async (input: NoArgumentInteractorInput) => {
      signal.throwIfAborted();
      const interactor = await resolveInteractor({
        ...input.execution,
        appBundleId: input.options?.appBundleId,
        signal,
      });
      await interactor.actionButton();
    },
  });
}
