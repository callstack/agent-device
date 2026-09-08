import { AppError } from '@agent-device/kernel/errors';
import { MAESTRO_PERMISSION_VALUES } from '@agent-device/maestro';

export type MaestroPermissionMutation = {
  readonly state: 'grant' | 'deny' | 'reset';
  readonly permission: string;
  readonly mode?: 'full' | 'limited';
};

/**
 * Canonical Maestro names each `settings permission` backend serves
 * individually. `all` is not listed: it travels as one `settings permission`
 * call and each backend resolves it (iOS `simctl privacy … all`, Android's
 * declared-permission intersection). Names outside these lists (iOS
 * speech/usertracking/homekit/health; Android custom ids) fail loudly below
 * instead of being silently skipped.
 */
const EXPANDABLE_PERMISSIONS = {
  android: [
    'bluetooth',
    'calendar',
    'camera',
    'contacts',
    'location',
    'media-library',
    'microphone',
    'notifications',
    'phone',
    'photos',
    'sms',
    'storage',
  ],
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
    'Supported: all, bluetooth, calendar, camera, contacts, location, media-library, microphone, notifications, phone, photos, sms, storage. Android custom permission ids are attempted through all, not individually.',
  ios: 'Supported: all, calendar, camera, contacts, location, media-library, microphone, motion, notifications, photos, reminders, siri. Granular iOS values: location always|inuse|never, photos limited.',
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
    // never denies access; unset resets to the prompt state.
    never: { state: 'deny', permission: 'location' },
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
 * mutations. `all` travels as one backend call first so specific entries
 * always override it regardless of authored order. Values arrive lowercased
 * from the Maestro runtime layer; anything else is refused.
 * The expansion is fully validated here, so callers must map before issuing
 * any mutation — a rejected map changes nothing.
 */
export function mapMaestroSetPermissions(
  permissions: Readonly<Record<string, string>>,
  platform: 'ios' | 'android',
): MaestroPermissionMutation[] {
  const entries = Object.entries(permissions);
  if (entries.length === 0) {
    throw new AppError('INVALID_ARGS', 'Maestro setPermissions requires at least one permission.');
  }
  const mutations: MaestroPermissionMutation[] = [];
  const specific = new Map<string, string>();
  for (const [name, value] of entries) {
    if (name.toLowerCase() === 'all') {
      mutations.push(mapMaestroAll(value));
    } else {
      specific.set(canonicalName(name), value);
    }
  }
  for (const [name, value] of specific) {
    mutations.push(mapMaestroPermission(name, value, platform));
  }
  return mutations;
}

/** `all` accepts only the plain values; granular ones name no single backend state. */
function mapMaestroAll(value: string): MaestroPermissionMutation {
  const state = PLAIN_VALUE_STATES[value as keyof typeof PLAIN_VALUE_STATES];
  if (!MAESTRO_PERMISSION_VALUES.has(value) || !state) {
    throw new AppError(
      'INVALID_ARGS',
      `Permission 'all' can be set to 'allow', 'deny' or 'unset', not '${value}'.`,
    );
  }
  return { state, permission: 'all' };
}

function mapMaestroPermission(
  name: string,
  value: string,
  platform: 'ios' | 'android',
): MaestroPermissionMutation {
  if (!new Set<string>(EXPANDABLE_PERMISSIONS[platform]).has(name)) {
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
