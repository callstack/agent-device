import type { DeviceInfo } from '@agent-device/kernel/device';
import {
  AppError,
  createRuntimeContractInvalidError,
  INTERACTOR_BINDING_REFUSAL_REASONS,
} from '@agent-device/kernel/errors';
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
  if (method) return method;
  throw createRuntimeContractInvalidError(
    `${operation} was admitted but its bound interactor has no implementation.`,
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
      {
        reason: INTERACTOR_BINDING_REFUSAL_REASONS.providerInteractorMissing.reason,
        deviceId: params.device.id,
      },
    );
  };
}

/**
 * How a family turns one resolved interactor into one of its own typed operations. Every row
 * shares this shape, which is what lets one adapter drive all of them: the family owns what the
 * operation *does* and declares its rows beside its binders, and the adapters below own only which
 * interactor a row reaches and how a refusal reads.
 */
export type InteractorOperationDefinition<Operations extends object> = Readonly<{
  /** The facts key that admits it, and the operations key it binds. */
  operation: keyof Operations;
  /** How a provider fail-closed refusal names this operation to the caller. */
  label: string;
  bind: (
    signal: AbortSignal,
    resolveInteractor: (runner: RunnerContext) => Promise<Interactor>,
  ) => Partial<Operations>;
}>;

/**
 * `operations` is the rows of every family the owner implements, so an owner evaluates only those
 * families. `facts[operation]` alone still decides whether a row binds: `facts` is an owner's full
 * `RuntimeFacts.operations` (extra keys are ignored) or a narrower standalone map, and a key it
 * never defines is never bindable.
 */
type AdmittedInteractorOperationParams<Operations extends object, Resolver> = Readonly<{
  device: DeviceInfo;
  signal: AbortSignal;
  resolveInteractor: Resolver;
  operations: readonly InteractorOperationDefinition<Operations>[];
  facts: Readonly<Partial<Record<keyof Operations, Readonly<{ available: boolean }>>>>;
}>;

/**
 * Walks the rows once, binding each operation the facts admitted through whichever interactor
 * source the caller's entry point supplies. The source is the only thing that differs between a
 * local owner and a provider.
 */
function bindAdmittedInteractorOperations<Operations extends object, Resolver>(
  params: AdmittedInteractorOperationParams<Operations, Resolver>,
  source: (
    definition: InteractorOperationDefinition<Operations>,
  ) => (runner: RunnerContext) => Promise<Interactor>,
): Partial<Operations> {
  const bound: Partial<Operations> = {};
  for (const definition of params.operations) {
    if (!params.facts[definition.operation]?.available) continue;
    Object.assign(bound, definition.bind(params.signal, source(definition)));
  }
  return bound;
}

/**
 * Binds whichever local operations the owner's own facts admitted. The owner keeps full
 * authority — its facts alone decide what binds — this only removes the once-per-operation
 * ternary that read them.
 */
export function bindAdmittedLocalInteractorOperations<Operations extends object>(
  params: AdmittedInteractorOperationParams<Operations, LocalInteractorOperationResolver>,
): Partial<Operations> {
  return bindAdmittedInteractorOperations(params, () => localInteractorSource(params));
}

/**
 * Binds whichever provider operations the owner's own facts admitted, failing closed when the
 * exact owner no longer exposes its interactor. Each refusal names the operation the caller asked
 * for, which is what the per-operation `label` carries.
 */
export function bindAdmittedProviderInteractorOperations<Operations extends object>(
  params: AdmittedInteractorOperationParams<Operations, ProviderInteractorOperationResolver>,
): Partial<Operations> {
  return bindAdmittedInteractorOperations(params, (definition) =>
    providerInteractorSource({ ...params, operation: definition.label }),
  );
}
