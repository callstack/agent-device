import type { DeviceInfo } from '@agent-device/kernel/device';
import { bindLocalBackInteractor, bindProviderBackInteractor } from './back-runtime.ts';
import { bindLocalHomeInteractor, bindProviderHomeInteractor } from './home-runtime.ts';
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
 * one bind call, no owner mechanics in between. This tuple is the single canonical declaration:
 * the {@link NavigationInteractorOperation} union type is derived from it below, and
 * `LOCAL_BINDERS`/`PROVIDER_BINDERS`'s `Record<NavigationInteractorOperation, …>` types are then
 * checked against that derived union — so a member can never be added to one and silently missing
 * from another. Not caller-supplied: `facts[operation]` is the only thing that decides whether an
 * operation binds — a key this tuple names but the caller's facts never define is simply never
 * available (`facts[operation]?.available` reads `undefined`), which is how a caller passing a
 * narrower, dedicated facts object (e.g. Limrun's keyboard-less navigation facts) opts a subset out.
 */
const NAVIGATION_INTERACTOR_OPERATIONS = [
  'back',
  'home',
  'setOrientation',
  'tvRemote',
  'keyboardStatus',
  'keyboardDismiss',
  'keyboardEnter',
] as const;

export type NavigationInteractorOperation = (typeof NAVIGATION_INTERACTOR_OPERATIONS)[number];

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
  Record<
    NavigationInteractorOperation,
    (params: LocalBinderParams) => Partial<PlatformRuntimeOperations>
  >
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
type NavigationOperationFacts = Readonly<
  Partial<Record<NavigationInteractorOperation, RuntimeOperationFact>>
>;

/** Walks every navigation operation against one binder table, binding each the facts admitted. */
function bindAdmittedInteractorOperations<Resolver>(
  binders: Readonly<
    Record<
      NavigationInteractorOperation,
      (params: {
        device: DeviceInfo;
        signal: AbortSignal;
        resolveInteractor: Resolver;
      }) => Partial<PlatformRuntimeOperations>
    >
  >,
  params: Readonly<{
    device: DeviceInfo;
    signal: AbortSignal;
    resolveInteractor: Resolver;
    facts: NavigationOperationFacts;
  }>,
): Partial<PlatformRuntimeOperations> {
  const { device, signal, resolveInteractor, facts } = params;
  const bound: Partial<PlatformRuntimeOperations> = {};
  for (const operation of NAVIGATION_INTERACTOR_OPERATIONS) {
    if (facts[operation]?.available) {
      Object.assign(bound, binders[operation]({ device, signal, resolveInteractor }));
    }
  }
  return bound;
}

/**
 * Binds whichever local operations the owner's own facts admitted. The owner keeps full
 * authority — its facts alone decide what binds — this only removes the seven-times-repeated
 * ternary that read them.
 */
export function bindAdmittedLocalInteractorOperations(
  params: Readonly<{
    device: DeviceInfo;
    signal: AbortSignal;
    resolveInteractor: LocalInteractorOperationResolver;
    facts: NavigationOperationFacts;
  }>,
): Partial<PlatformRuntimeOperations> {
  return bindAdmittedInteractorOperations(LOCAL_BINDERS, params);
}

/**
 * Binds whichever provider operations the owner's own facts admitted. Provider bindings fail
 * closed when their exact owner no longer exposes its interactor (see the individual
 * `bindProvider…Interactor` functions this table dispatches to).
 */
export function bindAdmittedProviderInteractorOperations(
  params: Readonly<{
    device: DeviceInfo;
    signal: AbortSignal;
    resolveInteractor: ProviderInteractorOperationResolver;
    facts: NavigationOperationFacts;
  }>,
): Partial<PlatformRuntimeOperations> {
  return bindAdmittedInteractorOperations(PROVIDER_BINDERS, params);
}
