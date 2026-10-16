// The public API vocabulary for device settings and permission grants.

import type { DeviceCommandBaseOptions } from './client-connection.ts';
import type {
  MACOS_PERMISSION_TARGETS,
  MOBILE_PERMISSION_TARGETS,
  PermissionAction,
  PermissionMode,
  SETTINGS,
  SettingName,
} from './settings-catalog.ts';

/** Every permission the public client can name: the app-scoped targets plus the macOS ones. */
export type PermissionTarget =
  | (typeof MOBILE_PERMISSION_TARGETS)[number]
  | (typeof MACOS_PERMISSION_TARGETS)[number];

type FormState<Form> = Form extends { kind: 'on-off' }
  ? 'on' | 'off'
  : Form extends { kind: 'choice'; states: readonly (infer State)[] }
    ? State
    : never;

type SettingState<Name extends SettingName> = FormState<(typeof SETTINGS)[Name]['forms'][number]>;

/** Settings whose whole input is a state: no app, coordinates, or permission target. */
type StateOnlySetting = {
  [Name in SettingName]: (typeof SETTINGS)[Name] extends { app: string } ? never : Name;
}[SettingName];

/** A readable setting omits `state` to read the value the target holds. */
type StateOnlySettingOptions = {
  [Name in StateOnlySetting]: DeviceCommandBaseOptions &
    ((typeof SETTINGS)[Name] extends { readable: true }
      ? { setting: Name; state?: SettingState<Name> }
      : { setting: Name; state: SettingState<Name> });
}[StateOnlySetting];

export type SettingsUpdateOptions =
  | StateOnlySettingOptions
  | (DeviceCommandBaseOptions & {
      setting: 'clear-app-state';
      state: 'clear';
      app?: string;
    })
  /** Android only. Naming an app is refused with `setting_app_not_consumed`. */
  | (DeviceCommandBaseOptions & {
      setting: 'mobile-data';
      state: 'on' | 'off';
      app?: string;
    })
  /** On Apple simulators `on`/`off` is a location-permission change for `app` (or the session app). */
  | (DeviceCommandBaseOptions & {
      setting: 'location';
      state: 'on' | 'off';
      app?: string;
    })
  | (DeviceCommandBaseOptions & {
      setting: 'location';
      state: 'set';
      latitude: number;
      longitude: number;
      app?: string;
    })
  | (DeviceCommandBaseOptions & {
      setting: 'permission';
      state: PermissionAction;
      permission: PermissionTarget;
      mode?: PermissionMode;
      /**
       * The app the permission changes, by bundle id, package name, or app name, resolved as `open`
       * resolves it: an iOS simulator matches display names and accepts only an installed bundle
       * id, Android accepts only an installed package and refuses a name that resolves to an intent
       * with `setting_app_not_package`, and a Limrun iOS session resolves only the `settings`
       * alias. Without it the session app is used; no app has to be running or open. macOS
       * permissions are host-level TCC grants, so naming an app there is refused.
       */
      app?: string;
    });
