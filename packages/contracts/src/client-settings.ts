// The public API vocabulary for device settings and permission grants.

import type { DeviceCommandBaseOptions } from './client-connection.ts';
import type {
  MACOS_PERMISSION_TARGETS,
  MOBILE_PERMISSION_TARGETS,
  PermissionAction,
  PermissionMode,
  SETTINGS,
  SETTING_RESET_STATE,
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
    : Form extends { kind: 'value' }
      ? typeof SETTING_RESET_STATE | (string & {})
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

/**
 * Settings that change the whole device on Android and wherever else they run; naming an app is
 * refused with `setting_app_not_consumed`.
 */
type DeviceLevelToggleSetting = {
  [Name in SettingName]: (typeof SETTINGS)[Name] extends {
    app: 'input';
    appScope: { mobile: 'device-level' };
  }
    ? Name
    : never;
}[SettingName];

type DeviceLevelToggleOptions = {
  [Name in DeviceLevelToggleSetting]: DeviceCommandBaseOptions & {
    setting: Name;
    state: SettingState<Name>;
    app?: string;
  };
}[DeviceLevelToggleSetting];

/** The permission targets whose catalog form declares `modes`; no other target takes a mode. */
type ModedPermissionTarget = Extract<
  (typeof SETTINGS)['permission']['forms'][number],
  { modes: readonly string[] }
>['targets'][number];

type PermissionUpdateOptions = DeviceCommandBaseOptions & {
  setting: 'permission';
  state: PermissionAction;
  /**
   * The app the permission changes, by bundle id, package name, or app name, resolved as `open`
   * resolves it: an iOS simulator, local or Limrun, matches display names and accepts only an
   * installed bundle id, and Android accepts only an installed package and refuses a name that
   * resolves to an intent with `setting_app_not_package`. Without it the session app is used;
   * no app has to be running or open. macOS permissions are host-level TCC grants, so naming an
   * app there is refused.
   */
  app?: string;
};

export type SettingsUpdateOptions =
  | StateOnlySettingOptions
  | DeviceLevelToggleOptions
  | (DeviceCommandBaseOptions & {
      setting: 'clear-app-state';
      state: 'clear';
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
  | (PermissionUpdateOptions & { permission: ModedPermissionTarget; mode?: PermissionMode })
  | (PermissionUpdateOptions & {
      permission: Exclude<PermissionTarget, ModedPermissionTarget>;
      mode?: never;
    });

/** Call input for a permission that has not been narrowed to one target. */
export type ModeFreePermissionUpdateOptions = PermissionUpdateOptions & {
  permission: PermissionTarget;
  mode?: never;
};
