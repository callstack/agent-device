import { AppError } from '@agent-device/kernel/errors';

/**
 * The `settings permission` vocabulary, declared once. These collections are what the parsers
 * below, the public client permission types, the CLI's membership sets, and the permission-name
 * fragments of `settings` help and its invalid-args message are built from, and their order is
 * the order `settings` help lists the names in.
 *
 * Acceptance is not support: each backend keeps its own target mapping and its own support check,
 * so a name accepted here never promises that the selected platform serves it.
 */
export const PERMISSION_ACTIONS = ['grant', 'deny', 'reset'] as const;
export const PERMISSION_MODES = ['full', 'limited'] as const;

/** The app-scoped targets, the only ones `parsePermissionTarget` accepts. */
export const MOBILE_PERMISSION_TARGETS = [
  'all',
  'camera',
  'microphone',
  'photos',
  'contacts',
  'contacts-limited',
  'notifications',
  'calendar',
  'location',
  'location-always',
  'media-library',
  'motion',
  'reminders',
  'siri',
] as const;

/** The desktop targets the CLI and the public client accept; `parsePermissionTarget` refuses them. */
export const MACOS_PERMISSION_TARGETS = [
  'accessibility',
  'screen-recording',
  'input-monitoring',
] as const;

export type PermissionAction = (typeof PERMISSION_ACTIONS)[number];
export type PermissionMode = (typeof PERMISSION_MODES)[number];
export type MobilePermissionTarget = (typeof MOBILE_PERMISSION_TARGETS)[number];
/**
 * The app-scoped vocabulary `parsePermissionTarget` returns. The public client's `PermissionTarget`
 * in `client-settings.ts` is wider: it also names the macOS targets.
 */
export type PermissionTarget = MobilePermissionTarget;

export type SettingOptions = {
  permissionTarget?: string;
  permissionMode?: string;
  latitude?: number;
  longitude?: number;
};

const SETTINGS_WIFI_USAGE = '<wifi|airplane|location> <on|off>';
const SETTINGS_LOCATION_SET_USAGE = 'location set <lat> <lon>';
const SETTINGS_ANIMATIONS_USAGE = 'animations <on|off>';
const SETTINGS_APPEARANCE_USAGE = 'appearance <light|dark|toggle>';
const SETTINGS_FACEID_USAGE = 'faceid <match|nonmatch|enroll|unenroll>';
const SETTINGS_TOUCHID_USAGE = 'touchid <match|nonmatch|enroll|unenroll>';
const SETTINGS_FINGERPRINT_USAGE = 'fingerprint <match|nonmatch>';
const SETTINGS_CLEAR_APP_STATE_USAGE = 'clear-app-state [app-id]';
const SETTINGS_RESET_KEYCHAIN_USAGE = 'reset-keychain clear';
const SETTINGS_PERMISSION_USAGE = `permission <${PERMISSION_ACTIONS.join('|')}> <${MOBILE_PERMISSION_TARGETS.join('|')}> [${PERMISSION_MODES.join('|')}]`;
/**
 * The macOS permission form. Its action list is the subset the macOS owner serves (`deny` is
 * refused there), so it stays a literal while the accepted names come from the vocabulary.
 */
export const SETTINGS_MACOS_PERMISSION_USAGE = `permission <grant|reset> <${MACOS_PERMISSION_TARGETS.join('|')}>`;
const SETTINGS_MACOS_SUPPORTED_MESSAGE = `macOS supports only settings ${SETTINGS_APPEARANCE_USAGE} and settings ${SETTINGS_MACOS_PERMISSION_USAGE}. wifi|airplane|location|animations remain unsupported on macOS.`;

export const SETTINGS_USAGE_OVERRIDE = [
  `settings ${SETTINGS_WIFI_USAGE}`,
  `settings ${SETTINGS_LOCATION_SET_USAGE}`,
  `settings ${SETTINGS_ANIMATIONS_USAGE}`,
  `settings ${SETTINGS_APPEARANCE_USAGE}`,
  `settings ${SETTINGS_FACEID_USAGE}`,
  `settings ${SETTINGS_TOUCHID_USAGE}`,
  `settings ${SETTINGS_FINGERPRINT_USAGE}`,
  `settings ${SETTINGS_CLEAR_APP_STATE_USAGE}`,
  `settings ${SETTINGS_RESET_KEYCHAIN_USAGE}`,
  `settings ${SETTINGS_PERMISSION_USAGE}`,
  `settings ${SETTINGS_MACOS_PERMISSION_USAGE}`,
].join(' | ');

export const SETTINGS_INVALID_ARGS_MESSAGE = `settings requires ${SETTINGS_WIFI_USAGE}, ${SETTINGS_LOCATION_SET_USAGE}, ${SETTINGS_ANIMATIONS_USAGE}, ${SETTINGS_APPEARANCE_USAGE}, ${SETTINGS_FACEID_USAGE}, ${SETTINGS_TOUCHID_USAGE}, ${SETTINGS_FINGERPRINT_USAGE}, ${SETTINGS_CLEAR_APP_STATE_USAGE}, ${SETTINGS_RESET_KEYCHAIN_USAGE}, ${SETTINGS_PERMISSION_USAGE}, or ${SETTINGS_MACOS_PERMISSION_USAGE}`;

export function isMacOsSettingSupported(setting: string): boolean {
  const normalized = setting.trim().toLowerCase();
  return normalized === 'appearance' || normalized === 'permission';
}

export function getUnsupportedMacOsSettingMessage(setting: string): string {
  return `Unsupported macOS setting: ${setting}. ${SETTINGS_MACOS_SUPPORTED_MESSAGE}`;
}

/** The one membership rule every permission parser shares: a name matches itself, any casing. */
function findPermissionName<const TNames extends readonly string[]>(
  names: TNames,
  value: string | undefined,
): TNames[number] | undefined {
  const normalized = value?.trim().toLowerCase();
  return normalized === undefined ? undefined : names.find((name) => name === normalized);
}

export function parsePermissionAction(action: string): PermissionAction {
  const parsed = findPermissionName(PERMISSION_ACTIONS, action);
  if (parsed !== undefined) return parsed;
  throw new AppError(
    'INVALID_ARGS',
    `Invalid permission action: ${action}. Use ${PERMISSION_ACTIONS.join('|')}.`,
  );
}

export function parsePermissionTarget(value: string | undefined): PermissionTarget {
  const parsed = findPermissionName(MOBILE_PERMISSION_TARGETS, value);
  if (parsed !== undefined) return parsed;
  throw new AppError(
    'INVALID_ARGS',
    `permission setting requires a target: ${MOBILE_PERMISSION_TARGETS.join('|')}`,
  );
}
