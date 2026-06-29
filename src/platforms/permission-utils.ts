import { AppError } from '../kernel/errors.ts';

export type PermissionAction = 'grant' | 'deny' | 'reset';
export type PermissionTarget =
  | 'camera'
  | 'microphone'
  | 'photos'
  | 'contacts'
  | 'contacts-limited'
  | 'notifications'
  | 'calendar'
  | 'location'
  | 'location-always'
  | 'media-library'
  | 'motion'
  | 'reminders'
  | 'siri';
export type SettingOptions = {
  permissionTarget?: string;
  permissionMode?: string;
  latitude?: number;
  longitude?: number;
};
const PERMISSION_TARGETS: readonly PermissionTarget[] = [
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
];

export function parsePermissionAction(action: string): PermissionAction {
  const normalized = action.trim().toLowerCase();
  if (normalized === 'grant') return 'grant';
  if (normalized === 'deny') return 'deny';
  if (normalized === 'reset') return 'reset';
  throw new AppError('INVALID_ARGS', `Invalid permission action: ${action}. Use grant|deny|reset.`);
}

export function parsePermissionTarget(value: string | undefined): PermissionTarget {
  const normalized = value?.trim().toLowerCase();
  if (
    normalized === 'camera' ||
    normalized === 'microphone' ||
    normalized === 'photos' ||
    normalized === 'contacts' ||
    normalized === 'contacts-limited' ||
    normalized === 'notifications' ||
    normalized === 'calendar' ||
    normalized === 'location' ||
    normalized === 'location-always' ||
    normalized === 'media-library' ||
    normalized === 'motion' ||
    normalized === 'reminders' ||
    normalized === 'siri'
  ) {
    return normalized;
  }
  throw new AppError(
    'INVALID_ARGS',
    `permission setting requires a target: ${PERMISSION_TARGETS.join('|')}`,
  );
}
