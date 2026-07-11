const SETTINGS_WIFI_USAGE = '<wifi|airplane|location> <on|off>';
const SETTINGS_LOCATION_SET_USAGE = 'location set <lat> <lon>';
const SETTINGS_ANIMATIONS_USAGE = 'animations <on|off>';
const SETTINGS_APPEARANCE_USAGE = 'appearance <light|dark|toggle>';
const SETTINGS_FACEID_USAGE = 'faceid <match|nonmatch|enroll|unenroll>';
const SETTINGS_TOUCHID_USAGE = 'touchid <match|nonmatch|enroll|unenroll>';
const SETTINGS_FINGERPRINT_USAGE = 'fingerprint <match|nonmatch>';
const SETTINGS_CLEAR_APP_STATE_USAGE = 'clear-app-state [app-id]';
const SETTINGS_PERMISSION_USAGE =
  'permission <grant|deny|reset> <camera|microphone|photos|contacts|contacts-limited|notifications|calendar|location|location-always|media-library|motion|reminders|siri> [full|limited]';
const SETTINGS_MACOS_PERMISSION_USAGE =
  'permission <grant|reset> <accessibility|screen-recording|input-monitoring>';
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
  `settings ${SETTINGS_PERMISSION_USAGE}`,
  `settings ${SETTINGS_MACOS_PERMISSION_USAGE}`,
].join(' | ');

export const SETTINGS_INVALID_ARGS_MESSAGE = `settings requires ${SETTINGS_WIFI_USAGE}, ${SETTINGS_LOCATION_SET_USAGE}, ${SETTINGS_ANIMATIONS_USAGE}, ${SETTINGS_APPEARANCE_USAGE}, ${SETTINGS_FACEID_USAGE}, ${SETTINGS_TOUCHID_USAGE}, ${SETTINGS_FINGERPRINT_USAGE}, ${SETTINGS_CLEAR_APP_STATE_USAGE}, ${SETTINGS_PERMISSION_USAGE}, or ${SETTINGS_MACOS_PERMISSION_USAGE}`;

export function isMacOsSettingSupported(setting: string): boolean {
  const normalized = setting.trim().toLowerCase();
  return normalized === 'appearance' || normalized === 'permission';
}

export function getUnsupportedMacOsSettingMessage(setting: string): string {
  return `Unsupported macOS setting: ${setting}. ${SETTINGS_MACOS_SUPPORTED_MESSAGE}`;
}
