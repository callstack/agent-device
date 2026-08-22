import type { DeviceInfo } from '@agent-device/kernel/device';
import {
  bindLocalBackInteractor,
  bindProviderBackInteractor,
} from './back-runtime.ts';
import {
  bindLocalHomeInteractor,
  bindProviderHomeInteractor,
} from './home-runtime.ts';
import {
  bindLocalKeyboardDismissInteractor,
  bindLocalKeyboardEnterInteractor,
  bindLocalKeyboardStatusInteractor,
  bindProviderKeyboardDismissInteractor,
  bindProviderKeyboardEnterInteractor,
  bindProviderKeyboardStatusInteractor,
} from './keyboard-runtime.ts';
import {
  bindLocalOrientationInteractor,
  bindProviderOrientationInteractor,
} from './orientation-runtime.ts';
import type {
  LocalInteractorOperationResolver,
  ProviderInteractorOperationResolver,
} from './interactor-operation-binding.ts';
import type { PlatformRuntimeOperations } from './platform-runtime-operations.ts';
import type { RuntimeOperationFact } from './platform-runtime.ts';
import {
  bindLocalTvRemoteInteractor,
  bindProviderTvRemoteInteractor,
} from './tv-remote-runtime.ts';

/**
 * The seven navigation/keyboard operations every owner admits from the same shape: one fact,
 * one bind call, no owner mechanics in between. Naming the set here — rather than at each of the
 * seven owner call sites — is what lets an owner request a subset (`operations: [...]`) instead
 * of hand-writing the same `facts.operations.<key>.available ? bind…(resolver) : {}` ternary
 * seven times over.
 */
export type NavigationInteractorOperation =
  | 'back'
  | 'home'
  | 'setOrientation'
  | 'tvRemote'
  | 'keyboardStatus'
  | 'keyboardDismiss'
  | 'keyboardEnter';

type LocalBinderParams = Readonly<{
  device: DeviceInfo;
  signal: AbortSignal;
  resolveInteractor: LocalInteractorOperationResolver;
}>;
type ProviderBinderParams = Readonly<{
  device: DeviceInfo;
  signal: AbortSignal;
  resolveInteractor: ProviderInteractorOperationResolver;
}>;

const LOCAL_BINDERS: Readonly<
  Record<NavigationInteractorOperation, (params: LocalBinderParams) => Partial<PlatformRuntimeOperations>>
> = Object.freeze({
  back: bindLocalBackInteractor,
  home: bindLocalHomeInteractor,
  setOrientation: bindLocalOrientationInteractor,
  tvRemote: bindLocalTvRemoteInteractor,
  keyboardStatus: bindLocalKeyboardStatusInteractor,
  keyboardDismiss: bindLocalKeyboardDismissInteractor,
  keyboardEnter: bindLocalKeyboardEnterInteractor,
});

const PROVIDER_BINDERS: Readonly<
  Record<
    NavigationInteractorOperation,
    (params: ProviderBinderParams) => Partial<PlatformRuntimeOperations>
  >
> = Object.freeze({
  back: bindProviderBackInteractor,
  home: bindProviderHomeInteractor,
  setOrientation: bindProviderOrientationInteractor,
  tvRemote: bindProviderTvRemoteInteractor,
  keyboardStatus: bindProviderKeyboardStatusInteractor,
  keyboardDismiss: bindProviderKeyboardDismissInteractor,
  keyboardEnter: bindProviderKeyboardEnterInteractor,
});

/**
 * The operation-facts slice every caller already holds: an owner's full `RuntimeFacts.operations`
 * (narrows structurally — extra keys are ignored), or, for an owner whose navigation facts are
 * assembled standalone (see `platform-apple/src/navigation/runtime.ts`, `provider-limrun`'s
 * `limrunNavigationOperationFacts`), that flat map directly — which may cover only the subset of
 * operations the owner admits at all, so a missing key here is simply never bindable.
 */
type NavigationOperationFacts = Readonly<Partial<Record<NavigationInteractorOperation, RuntimeOperationFact>>>;

/** Walks the requested operations against one binder table, binding each the facts admitted. */
function bindAdmittedInteractorOperations<Resolver>(
  binders: Readonly<Record<NavigationInteractorOperation, (params: {
    device: DeviceInfo;
    signal: AbortSignal;
    resolveInteractor: Resolver;
  }) => Partial<PlatformRuntimeOperations>>>,
  params: Readonly<{
    device: DeviceInfo;
    signal: AbortSignal;
    resolveInteractor: Resolver;
    facts: NavigationOperationFacts;
    operations: readonly NavigationInteractorOperation[];
  }>,
): Partial<PlatformRuntimeOperations> {
  const { device, signal, resolveInteractor, facts, operations } = params;
  const bound: Partial<PlatformRuntimeOperations> = {};
  for (const operation of operations) {
    if (facts[operation]?.available) {
      Object.assign(bound, binders[operation]({ device, signal, resolveInteractor }));
    }
  }
  return bound;
}

/**
 * Binds whichever of the named local operations the owner's own facts admitted. The owner keeps
 * full authority — its facts still decide what binds — this only removes the seven-times-repeated
 * ternary that read them.
 */
export function bindAdmittedLocalInteractorOperations(
  params: Readonly<{
    device: DeviceInfo;
    signal: AbortSignal;
    resolveInteractor: LocalInteractorOperationResolver;
    facts: NavigationOperationFacts;
    operations: readonly NavigationInteractorOperation[];
  }>,
): Partial<PlatformRuntimeOperations> {
  return bindAdmittedInteractorOperations(LOCAL_BINDERS, params);
}

/**
 * Binds whichever of the named provider operations the owner's own facts admitted. Provider
 * bindings fail closed when their exact owner no longer exposes its interactor (see the
 * individual `bindProvider…Interactor` functions this table dispatches to).
 */
export function bindAdmittedProviderInteractorOperations(
  params: Readonly<{
    device: DeviceInfo;
    signal: AbortSignal;
    resolveInteractor: ProviderInteractorOperationResolver;
    facts: NavigationOperationFacts;
    operations: readonly NavigationInteractorOperation[];
  }>,
): Partial<PlatformRuntimeOperations> {
  return bindAdmittedInteractorOperations(PROVIDER_BINDERS, params);
}
