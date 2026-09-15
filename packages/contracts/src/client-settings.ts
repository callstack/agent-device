// The public API vocabulary for device settings and permission grants.

import type { DeviceCommandBaseOptions } from './client-connection.ts';
import type {
  MACOS_PERMISSION_TARGETS,
  MOBILE_PERMISSION_TARGETS,
  PermissionAction,
  PermissionMode,
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
      setting: 'wifi' | 'airplane' | 'location';
      state: 'on' | 'off';
    })
  | (DeviceCommandBaseOptions & {
      setting: 'location';
      state: 'set';
      latitude: number;
      longitude: number;
    })
  | (DeviceCommandBaseOptions & {
      setting: 'animations';
      state: 'on' | 'off';
    })
  | (DeviceCommandBaseOptions & {
      setting: 'appearance';
      state: 'light' | 'dark' | 'toggle';
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
    });
