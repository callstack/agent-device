import { AppError } from '@agent-device/kernel/errors';

export type MaestroPermissionMutation = {
  readonly state: 'grant' | 'deny' | 'reset';
  readonly permission: string;
  readonly mode?: 'full' | 'limited';
};

/**
 * Canonical Maestro names each `settings permission` backend can serve. Names
 * outside these lists (bluetooth/phone/sms/storage/location/calendar on
 * Android; speech/usertracking/homekit on iOS; health everywhere; custom
 * Android IDs) fail loudly below instead of being silently skipped —
 * extending the platform backends is a separate, device-verified change.
 */
const EXPANDABLE_PERMISSIONS = {
  android: ['camera', 'contacts', 'microphone', 'notifications', 'photos'],
  ios: [
    'calendar',
    'camera',
    'contacts',
    'location',
    'media-library',
    'microphone',
    'motion',
    'notifications',
    'photos',
    'reminders',
    'siri',
  ],
} as const;

/** Per-platform hint for names the backends cannot serve yet. */
const UNSUPPORTED_HINTS = {
  android:
    'Supported: camera, contacts, microphone, notifications, photos (via all or individually). Other names need platform-backend support first.',
  ios: 'Supported: calendar, camera, contacts, location, media-library, microphone, motion, notifications, photos, reminders, siri (via all or individually). Granular iOS values: location always|inuse|never, photos limited.',
} as const;

/** Non-canonical spellings accepted alongside the lists above. */
const PERMISSION_ALIASES: Readonly<Record<string, string>> = {
  medialibrary: 'media-library',
};

function canonicalName(name: string): string {
  const normalized = name.toLowerCase();
  return PERMISSION_ALIASES[normalized] ?? normalized;
}

/** Plain values map 1:1 onto settings states; granular iOS values map per permission. */
const PLAIN_VALUE_STATES = { allow: 'grant', deny: 'deny', unset: 'reset' } as const;

const GRANULAR_MUTATIONS: Record<string, Record<string, MaestroPermissionMutation>> = {
  location: {
    always: { state: 'grant', permission: 'location-always' },
    inuse: { state: 'grant', permission: 'location' },
    never: { state: 'reset', permission: 'location' },
  },
  photos: {
    limited: { state: 'grant', permission: 'photos', mode: 'limited' },
  },
};

const GRANULAR_HINTS: Record<string, string> = {
  location: 'Use allow|deny|unset, or the iOS granular always|inuse|never.',
  photos: 'Use allow|deny|unset, or the iOS granular limited.',
};

/**
 * Expand a Maestro `setPermissions` map into ordered `settings permission`
 * mutations. `all` expands to the platform's servable set first so specific
 * entries always override it regardless of authored order. Values arrive
 * lowercased from the Maestro runtime layer; anything else is refused.
 */
export function mapMaestroSetPermissions(
  permissions: Readonly<Record<string, string>>,
  platform: 'ios' | 'android',
): MaestroPermissionMutation[] {
  const entries = Object.entries(permissions);
  if (entries.length === 0) {
    throw new AppError('INVALID_ARGS', 'Maestro setPermissions requires at least one permission.');
  }
  const expandable = new Set<string>(EXPANDABLE_PERMISSIONS[platform]);
  const specific = new Map<string, string>();
  let allValue: string | undefined;
  for (const [name, value] of entries) {
    if (name.toLowerCase() === 'all') {
      allValue = value;
    } else {
      specific.set(canonicalName(name), value);
    }
  }
  const merged: Array<[string, string]> =
    allValue === undefined
      ? [...specific]
      : [
          ...EXPANDABLE_PERMISSIONS[platform].map((name): [string, string] => [name, allValue]),
          ...specific,
        ];
  return merged.map(([name, value]) => mapMaestroPermission(name, value, platform, expandable));
}

function mapMaestroPermission(
  name: string,
  value: string,
  platform: 'ios' | 'android',
  expandable: ReadonlySet<string>,
): MaestroPermissionMutation {
  if (!expandable.has(name)) {
    throw new AppError(
      'UNSUPPORTED_OPERATION',
      `Maestro permission "${name}" is not supported on ${platform} yet.`,
      { hint: UNSUPPORTED_HINTS[platform] },
    );
  }
  const granular = GRANULAR_MUTATIONS[name]?.[value];
  if (granular) return granular;
  const state = PLAIN_VALUE_STATES[value as keyof typeof PLAIN_VALUE_STATES];
  if (state) return { state, permission: name };
  throw new AppError('INVALID_ARGS', `Maestro permission "${name}" does not accept "${value}".`, {
    hint: GRANULAR_HINTS[name] ?? 'Use allow|deny|unset.',
  });
}
