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

/**
 * The preferred-text-size ladder `settings text-size` accepts, in the order `settings` help lists
 * it. Apple serves it natively — `simctl ui <device> content_size` reads and writes exactly these
 * names — and Android serves it through its `system font_scale` multiplier, so this ladder is the
 * cross-platform vocabulary and each owner maps it in its own native terms. Acceptance is not
 * support: an owner that cannot serve the ladder refuses at admission, on its own fact.
 */
export const TEXT_SIZE_CATEGORIES = [
  'extra-small',
  'small',
  'medium',
  'large',
  'extra-large',
  'extra-extra-large',
  'extra-extra-extra-large',
  'accessibility-medium',
  'accessibility-large',
  'accessibility-extra-large',
  'accessibility-extra-extra-large',
  'accessibility-extra-extra-extra-large',
] as const;

export type TextSizeCategory = (typeof TEXT_SIZE_CATEGORIES)[number];

/**
 * The appearances `settings appearance` accepts, in the order `settings` help lists them. Apple
 * applies them natively; Android maps them onto `ui_night_mode`. Acceptance is not support.
 */
export const APPEARANCE_ACTIONS = ['light', 'dark', 'toggle'] as const;

export type AppearanceAction = (typeof APPEARANCE_ACTIONS)[number];

/**
 * The state spellings `settings <setting> <state>` accepts. Unlike the appearance and permission
 * vocabularies these are aliases onto a boolean rather than a name the device echoes back, so
 * membership — not {@link findVocabularyName} — decides, and padding stays rejected: an
 * `adb shell settings put` argument with a stray space in it is a caller bug, not a spelling.
 */
const SETTING_STATE_ON = ['on', 'true', '1'];
const SETTING_STATE_OFF = ['off', 'false', '0'];

/**
 * The settings that answer a bare `settings <setting>` with the value the target holds. This is the
 * vocabulary every settings type and every settings owner reads it from; the matching value is
 * `READABLE_SETTINGS` in `platform-runtime-operations.ts`, where the CLI hub can evaluate it, and
 * that module pins the two equal in both directions at compile time.
 */
export type ReadableSetting = 'text-size';

/**
 * What `text-size` answers with. The ladder is shared across platforms, so a read names the
 * category the ladder calls the device's value *and* the value the platform itself reported: an
 * Apple content-size name, or an Android `font_scale` multiplier. The ladder is coarser than any
 * one platform's own scale, and `platformValue` is what keeps a normalized answer auditable.
 */
export type TextSizeSettingPayload = Readonly<{
  setting: 'text-size';
  category: TextSizeCategory;
  platformValue: string;
}>;

/**
 * The payload a readable setting answers with, keyed by the setting that answered. Each readable
 * setting has its own shape — a category and a multiplier are not the same observation — so the
 * discriminant is what lets a response be composed, recorded, and printed from one place without
 * assuming every setting is a ladder rung. A second readable setting joins this union and supplies
 * its own sentence in `describeSettingRead`, which is where the compiler then asks for it.
 */
export type ReadSettingResult = TextSizeSettingPayload;

/** Builds the ladder's read payload, so no owner renames its keys or drops the platform value. */
export function textSizeSettingPayload(
  category: TextSizeCategory,
  platformValue: string,
): TextSizeSettingPayload {
  return Object.freeze({ setting: 'text-size', category, platformValue });
}

/** The one sentence a settings read answers with, per payload shape rather than per call site. */
export function describeSettingRead(result: ReadSettingResult): string {
  return `Text size is ${result.category}`;
}

/**
 * The sentence a settings mutation answers with. It belongs to the vocabulary rather than the daemon
 * because it is a claim about the setting: `clear-app-state` names the app it cleared and `text-size`
 * names the rung it applied, and both are the same words whoever performs the write.
 */
export function describeSettingWrite(
  setting: string,
  state: string,
  appBundleId: string | undefined,
): string {
  if (setting === 'clear-app-state') return `Cleared user data for ${appBundleId}`;
  if (setting === 'text-size') return `Text size set to ${state}`;
  return `Updated setting: ${setting}`;
}

export type SettingOptions = {
  permissionTarget?: string;
  permissionMode?: string;
  latitude?: number;
  longitude?: number;
};

const SETTINGS_WIFI_USAGE = '<wifi|airplane|location> <on|off>';
const SETTINGS_LOCATION_SET_USAGE = 'location set <lat> <lon>';
const SETTINGS_ANIMATIONS_USAGE = 'animations <on|off>';
const SETTINGS_APPEARANCE_USAGE = `appearance <${APPEARANCE_ACTIONS.join('|')}>`;
const SETTINGS_FACEID_USAGE = 'faceid <match|nonmatch|enroll|unenroll>';
const SETTINGS_TOUCHID_USAGE = 'touchid <match|nonmatch|enroll|unenroll>';
const SETTINGS_FINGERPRINT_USAGE = 'fingerprint <match|nonmatch>';
const SETTINGS_CLEAR_APP_STATE_USAGE = 'clear-app-state [app-id]';
const SETTINGS_RESET_KEYCHAIN_USAGE = 'reset-keychain clear';
/**
 * The bracket is what makes `settings text-size` a read: the ladder is the write form, and the bare
 * setting asks the owner for the category it currently holds.
 */
const SETTINGS_TEXT_SIZE_USAGE = `text-size [${TEXT_SIZE_CATEGORIES.join('|')}]`;
const SETTINGS_PERMISSION_USAGE = `permission <${PERMISSION_ACTIONS.join('|')}> <${MOBILE_PERMISSION_TARGETS.join('|')}> [${PERMISSION_MODES.join('|')}]`;
/**
 * The macOS permission form. Its action list is the subset the macOS owner serves (`deny` is
 * refused there), so it stays a literal while the accepted names come from the vocabulary.
 */
export const SETTINGS_MACOS_PERMISSION_USAGE = `permission <grant|reset> <${MACOS_PERMISSION_TARGETS.join('|')}>`;
const SETTINGS_MACOS_SUPPORTED_MESSAGE = `macOS supports only settings ${SETTINGS_APPEARANCE_USAGE} and settings ${SETTINGS_MACOS_PERMISSION_USAGE}. wifi|airplane|location|animations|text-size remain unsupported on macOS.`;

export const SETTINGS_USAGE_OVERRIDE = [
  `settings ${SETTINGS_WIFI_USAGE}`,
  `settings ${SETTINGS_LOCATION_SET_USAGE}`,
  `settings ${SETTINGS_ANIMATIONS_USAGE}`,
  `settings ${SETTINGS_APPEARANCE_USAGE}`,
  `settings ${SETTINGS_TEXT_SIZE_USAGE}`,
  `settings ${SETTINGS_FACEID_USAGE}`,
  `settings ${SETTINGS_TOUCHID_USAGE}`,
  `settings ${SETTINGS_FINGERPRINT_USAGE}`,
  `settings ${SETTINGS_CLEAR_APP_STATE_USAGE}`,
  `settings ${SETTINGS_RESET_KEYCHAIN_USAGE}`,
  `settings ${SETTINGS_PERMISSION_USAGE}`,
  `settings ${SETTINGS_MACOS_PERMISSION_USAGE}`,
].join(' | ');

export const SETTINGS_INVALID_ARGS_MESSAGE = `settings requires ${SETTINGS_WIFI_USAGE}, ${SETTINGS_LOCATION_SET_USAGE}, ${SETTINGS_ANIMATIONS_USAGE}, ${SETTINGS_APPEARANCE_USAGE}, ${SETTINGS_TEXT_SIZE_USAGE}, ${SETTINGS_FACEID_USAGE}, ${SETTINGS_TOUCHID_USAGE}, ${SETTINGS_FINGERPRINT_USAGE}, ${SETTINGS_CLEAR_APP_STATE_USAGE}, ${SETTINGS_RESET_KEYCHAIN_USAGE}, ${SETTINGS_PERMISSION_USAGE}, or ${SETTINGS_MACOS_PERMISSION_USAGE}`;

export function isMacOsSettingSupported(setting: string): boolean {
  const normalized = setting.trim().toLowerCase();
  return normalized === 'appearance' || normalized === 'permission';
}

export function getUnsupportedMacOsSettingMessage(setting: string): string {
  return `Unsupported macOS setting: ${setting}. ${SETTINGS_MACOS_SUPPORTED_MESSAGE}`;
}

/**
 * The category a caller asked for. `simctl` exits 0 with `Invalid argument` for a category it does
 * not know, so a write must never delegate validation to the tool: every surface parses here
 * first, and the refusal names the whole ladder.
 */
export function parseTextSizeCategory(value: string | undefined): TextSizeCategory {
  const parsed = readTextSizeCategory(value);
  if (parsed !== undefined) return parsed;
  throw new AppError('INVALID_ARGS', invalidTextSizeMessage(value));
}

/** The refusal every surface that rejects an off-ladder category answers with. */
export function invalidTextSizeMessage(value: string | undefined): string {
  return `Invalid text size: ${value ?? ''}. Use ${TEXT_SIZE_CATEGORIES.join('|')}.`;
}

/** The category an owner reads back, or `undefined` for a value the ladder does not name. */
export function readTextSizeCategory(value: string | undefined): TextSizeCategory | undefined {
  return findVocabularyName(TEXT_SIZE_CATEGORIES, value);
}

/**
 * The one refusal an Apple target gives for a text-size request its leaf does not serve, shared by
 * the three surfaces that can answer it: the daemon (before it binds, so a request that never touched
 * a device also never expires the session ref frame), the Apple runtime's read fact, and the Apple
 * owner's own guard. The Apple write fact is one claim for the whole simulator family and
 * `simctl ui <device> content_size` is narrower than that, which is why a per-setting refusal has to
 * exist at all; a per-setting runtime fact is where it belongs once the fact model carries one, and
 * until then this is the single declaration rather than three copies of the prose.
 */
export const APPLE_TEXT_SIZE_LEAF_REFUSAL = Object.freeze({
  message: 'Reading or setting a text size is supported on iOS and iPadOS simulators.',
  hint: 'Run `xcrun simctl ui <device> content_size` on a booted iPhone or iPad simulator.',
  reason: 'setting-unsupported-on-leaf',
} as const);

/**
 * Simulator biometrics are driven through BiometricKit_Sim notifications, which only the iPhone and
 * iPad simulator runtimes observe; a post on an Apple TV or Vision Pro simulator exits 0 and changes
 * nothing, so the leaf is refused before anything is posted.
 */
export const APPLE_BIOMETRIC_LEAF_REFUSAL = Object.freeze({
  message: 'Face ID and Touch ID simulation is supported on iOS and iPadOS simulators.',
  hint: 'Select a booted iPhone or iPad simulator, then run `settings faceid <state>` or `settings touchid <state>`.',
  reason: 'setting-unsupported-on-leaf',
} as const);

/** The one membership rule every settings-vocabulary parser shares: a name matches itself, any casing. */
function findVocabularyName<const TNames extends readonly string[]>(
  names: TNames,
  value: string | undefined,
): TNames[number] | undefined {
  const normalized = value?.trim().toLowerCase();
  return normalized === undefined ? undefined : names.find((name) => name === normalized);
}

export function parsePermissionAction(action: string): PermissionAction {
  const parsed = findVocabularyName(PERMISSION_ACTIONS, action);
  if (parsed !== undefined) return parsed;
  throw new AppError(
    'INVALID_ARGS',
    `Invalid permission action: ${action}. Use ${PERMISSION_ACTIONS.join('|')}.`,
  );
}

export function parsePermissionTarget(value: string | undefined): PermissionTarget {
  const parsed = findVocabularyName(MOBILE_PERMISSION_TARGETS, value);
  if (parsed !== undefined) return parsed;
  throw new AppError(
    'INVALID_ARGS',
    `permission setting requires a target: ${MOBILE_PERMISSION_TARGETS.join('|')}`,
  );
}

/**
 * The appearance a caller asked for. Every surface that sets one parses here first: `simctl` and
 * `adb` both answer a bad token with a tool-specific error or a silent no-op, so the refusal has to
 * name the accepted set before a device is touched.
 */
export function parseAppearanceAction(state: string): AppearanceAction {
  const parsed = findVocabularyName(APPEARANCE_ACTIONS, state);
  if (parsed !== undefined) return parsed;
  throw new AppError(
    'INVALID_ARGS',
    `Invalid appearance state: ${state}. Use ${APPEARANCE_ACTIONS.join('|')}.`,
  );
}

/** The boolean a `settings <setting> <state>` positional spells, in any casing. */
export function parseSettingState(state: string): boolean {
  const normalized = state.toLowerCase();
  if (SETTING_STATE_ON.includes(normalized)) return true;
  if (SETTING_STATE_OFF.includes(normalized)) return false;
  throw new AppError('INVALID_ARGS', `Invalid setting state: ${state}`);
}
