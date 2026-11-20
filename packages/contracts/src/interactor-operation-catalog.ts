import { ALERT_INTERACTOR_OPERATIONS } from './alert-runtime.ts';
import { APP_EVENT_INTERACTOR_OPERATIONS } from './app-event-runtime.ts';
import { BACK_INTERACTOR_OPERATIONS } from './back-runtime.ts';
import { CLIPBOARD_INTERACTOR_OPERATIONS } from './clipboard-runtime.ts';
import type { InteractorOperationDefinition } from './interactor-operation-binding.ts';
import { KEYBOARD_INTERACTOR_OPERATIONS } from './keyboard-runtime.ts';
import { ORIENTATION_INTERACTOR_OPERATIONS } from './orientation-runtime.ts';
import type { PlatformRuntimeOperations } from './platform-runtime-operations.ts';
import { SETTINGS_INTERACTOR_OPERATIONS } from './settings-runtime.ts';
import { SYSTEM_BUTTON_INTERACTOR_OPERATIONS } from './system-button-runtime.ts';
import { TV_REMOTE_INTERACTOR_OPERATIONS } from './tv-remote-runtime.ts';

/**
 * Every operation whose whole binding is "one fact, one bind call, no owner mechanics in between"
 * — the navigation/keyboard leaves and the system-surface leaves that joined them in Wave 6.
 *
 * Each family declares its own rows beside its binders, and this is all of them, for an owner that
 * implements every family. An owner that implements a few passes those families' rows to the
 * adapters in `interactor-operation-binding.ts` instead, and so never evaluates the rest.
 */
const ALL_FAMILY_OPERATIONS = [
  ...BACK_INTERACTOR_OPERATIONS,
  ...SYSTEM_BUTTON_INTERACTOR_OPERATIONS,
  ...ORIENTATION_INTERACTOR_OPERATIONS,
  ...TV_REMOTE_INTERACTOR_OPERATIONS,
  ...KEYBOARD_INTERACTOR_OPERATIONS,
  ...CLIPBOARD_INTERACTOR_OPERATIONS,
  ...APP_EVENT_INTERACTOR_OPERATIONS,
  ...SETTINGS_INTERACTOR_OPERATIONS,
  ...ALERT_INTERACTOR_OPERATIONS,
] as const satisfies readonly InteractorOperationDefinition<PlatformRuntimeOperations>[];

export type CatalogInteractorOperation = (typeof ALL_FAMILY_OPERATIONS)[number]['operation'];

export const INTERACTOR_OPERATIONS: readonly InteractorOperationDefinition<
  Pick<PlatformRuntimeOperations, CatalogInteractorOperation>
>[] = ALL_FAMILY_OPERATIONS;
