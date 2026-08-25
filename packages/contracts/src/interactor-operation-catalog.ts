import type { DeviceInfo } from '@agent-device/kernel/device';
import { bindAlertLeg } from './alert-runtime.ts';
import { bindAppEvent } from './app-event-runtime.ts';
import { bindAppSwitcher } from './app-switcher-runtime.ts';
import { bindBack } from './back-runtime.ts';
import { bindClipboardRead, bindClipboardWrite } from './clipboard-runtime.ts';
import { bindHome } from './home-runtime.ts';
import { KEYBOARD_ACTION_LABELS, bindKeyboardAction } from './keyboard-runtime.ts';
import { bindOrientation } from './orientation-runtime.ts';
import { bindSetSetting } from './settings-runtime.ts';
import { bindTvRemote } from './tv-remote-runtime.ts';
import {
  localInteractorSource,
  providerInteractorSource,
  type LocalInteractorOperationResolver,
  type ProviderInteractorOperationResolver,
} from './interactor-operation-binding.ts';
import type { Interactor, RunnerContext } from './interactor-types.ts';
import type { PlatformRuntimeOperations } from './platform-runtime-operations.ts';
import type { RuntimeOperationFact } from './platform-runtime.ts';

/**
 * How a facet turns one resolved interactor into its own typed operations. Every catalog member
 * shares this shape, which is what lets one adapter drive all of them: the facet owns what the
 * operation *does*, and this module owns only which interactor it reaches and how a refusal reads.
 */
type InteractorOperationBinder = (
  signal: AbortSignal,
  resolveInteractor: (runner: RunnerContext) => Promise<Interactor>,
) => Partial<PlatformRuntimeOperations>;

type InteractorOperationDefinition = Readonly<{
  /** The facts key that admits it, and the operations key it binds. */
  operation: keyof PlatformRuntimeOperations;
  /** How a provider fail-closed refusal names this operation to the caller. */
  label: string;
  bind: InteractorOperationBinder;
}>;

/**
 * Every operation whose whole binding is "one fact, one bind call, no owner mechanics in between"
 * — the navigation/keyboard leaves and the system-surface leaves that joined them in Wave 6.
 *
 * One row per operation, declared once. It used to take three parallel declarations — a name
 * tuple, a local binder map, and a provider binder map — plus a mirrored
 * `bindLocal…Interactor`/`bindProvider…Interactor` pair in each facet whose only difference was
 * which interactor source to use and which label to name in a refusal. Both of those now live
 * here, in the two adapters below, so adding an operation is adding one row.
 *
 * Not caller-supplied: `facts[operation]` alone decides whether an operation binds, so a row whose
 * key the caller's facts never define is simply never available — which is how an owner with a
 * narrower, dedicated facts object (Limrun's keyboard-less navigation facts) opts a subset out.
 */
const INTERACTOR_OPERATIONS = [
  { operation: 'back', label: 'back', bind: bindBack },
  { operation: 'home', label: 'home', bind: bindHome },
  { operation: 'setOrientation', label: 'orientation', bind: bindOrientation },
  { operation: 'tvRemote', label: 'tv-remote', bind: bindTvRemote },
  {
    operation: 'keyboardStatus',
    label: KEYBOARD_ACTION_LABELS.keyboardStatus,
    bind: (signal, resolve) => bindKeyboardAction('keyboardStatus', signal, resolve),
  },
  {
    operation: 'keyboardDismiss',
    label: KEYBOARD_ACTION_LABELS.keyboardDismiss,
    bind: (signal, resolve) => bindKeyboardAction('keyboardDismiss', signal, resolve),
  },
  {
    operation: 'keyboardEnter',
    label: KEYBOARD_ACTION_LABELS.keyboardEnter,
    bind: (signal, resolve) => bindKeyboardAction('keyboardEnter', signal, resolve),
  },
  { operation: 'readClipboard', label: 'clipboard read', bind: bindClipboardRead },
  { operation: 'writeClipboard', label: 'clipboard write', bind: bindClipboardWrite },
  { operation: 'appSwitcher', label: 'app-switcher', bind: bindAppSwitcher },
  { operation: 'triggerAppEvent', label: 'trigger-app-event', bind: bindAppEvent },
  { operation: 'setSetting', label: 'settings', bind: bindSetSetting },
  {
    operation: 'readAlert',
    label: 'alert get',
    bind: (signal, resolve) => bindAlertLeg('readAlert', signal, resolve),
  },
  {
    operation: 'awaitAlert',
    label: 'alert wait',
    bind: (signal, resolve) => bindAlertLeg('awaitAlert', signal, resolve),
  },
  {
    operation: 'acceptAlert',
    label: 'alert accept',
    bind: (signal, resolve) => bindAlertLeg('acceptAlert', signal, resolve),
  },
  {
    operation: 'dismissAlert',
    label: 'alert dismiss',
    bind: (signal, resolve) => bindAlertLeg('dismissAlert', signal, resolve),
  },
] as const satisfies readonly InteractorOperationDefinition[];

export type CatalogInteractorOperation = (typeof INTERACTOR_OPERATIONS)[number]['operation'];

/**
 * The operation-facts slice every caller already holds: an owner's full `RuntimeFacts.operations`
 * (narrows structurally — extra keys are ignored), or, for an owner whose navigation facts are
 * assembled standalone (see `platform-apple/src/navigation/runtime.ts`, `provider-limrun`'s
 * `limrunNavigationOperationFacts`), that flat map directly — which may cover only the subset of
 * operations the owner admits at all, so a missing key here is simply never bindable.
 */
type CatalogOperationFacts = Readonly<
  Partial<Record<CatalogInteractorOperation, RuntimeOperationFact>>
>;

type CatalogBindParams<Resolver> = Readonly<{
  device: DeviceInfo;
  signal: AbortSignal;
  resolveInteractor: Resolver;
  facts: CatalogOperationFacts;
}>;

/**
 * Walks the catalog once, binding each operation the facts admitted through whichever interactor
 * source the caller's entry point supplies. The source is the only thing that differs between a
 * local owner and a provider.
 */
function bindAdmittedInteractorOperations<Resolver>(
  params: CatalogBindParams<Resolver>,
  source: (
    definition: InteractorOperationDefinition,
  ) => (runner: RunnerContext) => Promise<Interactor>,
): Partial<PlatformRuntimeOperations> {
  const bound: Partial<PlatformRuntimeOperations> = {};
  for (const definition of INTERACTOR_OPERATIONS) {
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
export function bindAdmittedLocalInteractorOperations(
  params: CatalogBindParams<LocalInteractorOperationResolver>,
): Partial<PlatformRuntimeOperations> {
  return bindAdmittedInteractorOperations(params, () => localInteractorSource(params));
}

/**
 * Binds whichever provider operations the owner's own facts admitted, failing closed when the
 * exact owner no longer exposes its interactor. Each refusal names the operation the caller asked
 * for, which is what the per-operation `label` carries.
 */
export function bindAdmittedProviderInteractorOperations(
  params: CatalogBindParams<ProviderInteractorOperationResolver>,
): Partial<PlatformRuntimeOperations> {
  return bindAdmittedInteractorOperations(params, (definition) =>
    providerInteractorSource({ ...params, operation: definition.label }),
  );
}
