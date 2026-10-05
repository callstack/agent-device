// The public API vocabulary for device settings and permission grants.

import type { DeviceCommandBaseOptions } from './client-connection.ts';
import type {
  MACOS_PERMISSION_TARGETS,
  MOBILE_PERMISSION_TARGETS,
  PermissionAction,
  PermissionMode,
  TextSizeCategory,
} from './settings.ts';

/**
 * Every permission the public client can name: the app-scoped subset plus the macOS-only one, both
 * from the owning declaration. Type-only on purpose — naming a permission must not pull
 * `settings.ts` and its `AppError` dependency onto the client's runtime path.
 */
export type PermissionTarget =
  | (typeof MOBILE_PERMISSION_TARGETS)[number]
  | (typeof MACOS_PERMISSION_TARGETS)[number];

export type SettingsUpdateOptions =
  | (DeviceCommandBaseOptions & {
      setting: 'clear-app-state';
      state: 'clear';
      app?: string;
    })
  | (DeviceCommandBaseOptions & {
      setting: 'reset-keychain';
      state: 'clear';
    })
  | (DeviceCommandBaseOptions & {
      setting: 'wifi' | 'airplane';
      state: 'on' | 'off';
    })
  /**
   * On Apple simulators `on`/`off` grants or revokes the app's location permission, so this leg
   * takes the same explicit `app` as `permission` and defaults to the session app. On Android the
   * toggle writes the global `location_mode` and consumes no app, so naming one there is refused
   * rather than dropped; `settingsAppScope` is the declaration.
   */
  | (DeviceCommandBaseOptions & {
      setting: 'location';
      state: 'on' | 'off';
      app?: string;
    })
  /**
   * `set` moves the device's own location for every target, so naming an app here is a contradiction
   * the daemon refuses with `setting_app_not_consumed` rather than a value it silently drops.
   */
  | (DeviceCommandBaseOptions & {
      setting: 'location';
      state: 'set';
      latitude: number;
      longitude: number;
      app?: string;
    })
  | (DeviceCommandBaseOptions & {
      setting: 'animations';
      state: 'on' | 'off';
    })
  | (DeviceCommandBaseOptions & {
      setting: 'appearance';
      state: 'light' | 'dark' | 'toggle';
    })
  /**
   * One member, two legs: with a `state` it applies that rung, and without one it asks the target
   * what it currently holds. The ladder is shared across platforms; an owner that serves neither
   * leg refuses on its own runtime fact rather than answering an empty value.
   */
  | (DeviceCommandBaseOptions & {
      setting: 'text-size';
      state?: TextSizeCategory;
    })
  | (DeviceCommandBaseOptions & {
      setting: 'faceid' | 'touchid';
      state: 'match' | 'nonmatch' | 'enroll' | 'unenroll';
    })
  | (DeviceCommandBaseOptions & {
      setting: 'fingerprint';
      state: 'match' | 'nonmatch';
    })
  | (DeviceCommandBaseOptions & {
      setting: 'permission';
      state: PermissionAction;
      permission: PermissionTarget;
      mode?: PermissionMode;
      /**
       * The app the permission changes, by bundle id or package name. Without it the app bound to
       * the session is used; with it no app has to be running or open, because `simctl privacy` and
       * Android's `pm` need only the id. macOS permissions are host-level TCC grants, so naming an
       * app there is refused rather than dropped.
       */
      app?: string;
    });
