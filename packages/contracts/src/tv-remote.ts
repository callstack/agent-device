import { AppError } from '@agent-device/kernel/errors';

type TvRemoteDurationMode = 'exact' | 'longpress';

type TvRemoteButtonDefinition = {
  aliases: readonly string[];
  androidKeyevent: string;
  appleRemoteButton: string;
  vegaKey: string;
};

const TV_REMOTE_DURATION_MODE = {
  android: 'longpress',
  apple: 'exact',
  vega: 'exact',
} as const satisfies Record<string, TvRemoteDurationMode>;

const TV_REMOTE_BUTTON_DEFINITIONS = {
  up: {
    aliases: [],
    androidKeyevent: 'KEYCODE_DPAD_UP',
    appleRemoteButton: 'up',
    vegaKey: 'KEY_UP',
  },
  down: {
    aliases: [],
    androidKeyevent: 'KEYCODE_DPAD_DOWN',
    appleRemoteButton: 'down',
    vegaKey: 'KEY_DOWN',
  },
  left: {
    aliases: [],
    androidKeyevent: 'KEYCODE_DPAD_LEFT',
    appleRemoteButton: 'left',
    vegaKey: 'KEY_LEFT',
  },
  right: {
    aliases: [],
    androidKeyevent: 'KEYCODE_DPAD_RIGHT',
    appleRemoteButton: 'right',
    vegaKey: 'KEY_RIGHT',
  },
  select: {
    aliases: ['ok', 'center', 'enter'],
    androidKeyevent: 'KEYCODE_DPAD_CENTER',
    appleRemoteButton: 'select',
    vegaKey: 'KEY_ENTER',
  },
  menu: {
    aliases: [],
    androidKeyevent: 'KEYCODE_MENU',
    appleRemoteButton: 'menu',
    vegaKey: 'KEY_MENU',
  },
  home: {
    aliases: [],
    androidKeyevent: 'KEYCODE_HOME',
    appleRemoteButton: 'home',
    vegaKey: 'KEY_HOMEPAGE',
  },
  back: {
    aliases: [],
    androidKeyevent: 'KEYCODE_BACK',
    appleRemoteButton: 'menu',
    vegaKey: 'KEY_BACK',
  },
} as const satisfies Record<string, TvRemoteButtonDefinition>;

export const TV_REMOTE_BUTTONS = Object.keys(
  TV_REMOTE_BUTTON_DEFINITIONS,
) as (keyof typeof TV_REMOTE_BUTTON_DEFINITIONS)[];

export const TV_REMOTE_BUTTON_USAGE = `<${TV_REMOTE_BUTTONS.join('|')}>`;

export type TvRemoteButton = (typeof TV_REMOTE_BUTTONS)[number];

export type AppleTvRemoteButton =
  (typeof TV_REMOTE_BUTTON_DEFINITIONS)[TvRemoteButton]['appleRemoteButton'];

export type VegaTvRemoteKey = (typeof TV_REMOTE_BUTTON_DEFINITIONS)[TvRemoteButton]['vegaKey'];

export function parseTvRemoteButton(value: string | undefined): TvRemoteButton {
  const normalized = value?.toLowerCase();
  if (isTvRemoteButton(normalized)) return normalized;
  const canonical = normalized ? TV_REMOTE_BUTTON_ALIAS_MAP.get(normalized) : undefined;
  if (canonical) return canonical;
  throw new AppError(
    'INVALID_ARGS',
    `tv-remote button must be one of: ${TV_REMOTE_BUTTONS.join(', ')}.`,
  );
}

function isTvRemoteButton(value: unknown): value is TvRemoteButton {
  return typeof value === 'string' && TV_REMOTE_BUTTONS.includes(value as TvRemoteButton);
}

export function toAppleTvRemoteButton(button: TvRemoteButton): AppleTvRemoteButton {
  return TV_REMOTE_BUTTON_DEFINITIONS[button].appleRemoteButton;
}

export function toAndroidTvRemoteKeyevent(button: TvRemoteButton): string {
  return TV_REMOTE_BUTTON_DEFINITIONS[button].androidKeyevent;
}

export function toVegaTvRemoteKey(button: TvRemoteButton): VegaTvRemoteKey {
  return TV_REMOTE_BUTTON_DEFINITIONS[button].vegaKey;
}

export function tvRemoteDurationMode(
  platform: keyof typeof TV_REMOTE_DURATION_MODE,
): TvRemoteDurationMode {
  return TV_REMOTE_DURATION_MODE[platform];
}

const TV_REMOTE_BUTTON_ALIAS_MAP = new Map<string, TvRemoteButton>(
  TV_REMOTE_BUTTONS.flatMap((button) =>
    TV_REMOTE_BUTTON_DEFINITIONS[button].aliases.map((alias) => [alias, button] as const),
  ),
);

/**
 * Volume, power, media, and TV keys: named presses that, like the remote buttons above, each map
 * to one platform key event. Only Android sends them; no other owner carries a key-event channel.
 */
const HARDWARE_KEY_DEFINITIONS = {
  'volume-up': { androidKeycode: 24 },
  'volume-down': { androidKeycode: 25 },
  mute: { androidKeycode: 164 },
  power: { androidKeycode: 26 },
  sleep: { androidKeycode: 223 },
  wake: { androidKeycode: 224 },
  'media-play-pause': { androidKeycode: 85 },
  'media-next': { androidKeycode: 87 },
  'media-previous': { androidKeycode: 88 },
  'media-rewind': { androidKeycode: 89 },
  'media-fast-forward': { androidKeycode: 90 },
  'channel-up': { androidKeycode: 166 },
  'channel-down': { androidKeycode: 167 },
  'last-channel': { androidKeycode: 229 },
  guide: { androidKeycode: 172 },
  info: { androidKeycode: 165 },
  captions: { androidKeycode: 175 },
  'tv-input': { androidKeycode: 178 },
  'color-red': { androidKeycode: 183 },
  'color-green': { androidKeycode: 184 },
  'color-yellow': { androidKeycode: 185 },
  'color-blue': { androidKeycode: 186 },
} as const satisfies Record<string, { androidKeycode: number }>;

export const HARDWARE_KEYS = Object.keys(
  HARDWARE_KEY_DEFINITIONS,
) as (keyof typeof HARDWARE_KEY_DEFINITIONS)[];

const ANDROID_KEYCODE_PREFIX = 'android-keycode:';

/** A Java `int`, the type of an Android `KeyEvent` keycode. */
const MAX_ANDROID_KEYCODE = 2_147_483_647;

export const HARDWARE_KEY_USAGE = `<${HARDWARE_KEYS.join('|')}|${ANDROID_KEYCODE_PREFIX}<n>>`;

export type HardwareKey = (typeof HARDWARE_KEYS)[number];

/**
 * A named key, or a raw Android keycode for a vendor remote button that no name covers, such as
 * an operator-specific channel or app key.
 */
export type HardwareKeyToken = HardwareKey | `${typeof ANDROID_KEYCODE_PREFIX}${number}`;

export function parseHardwareKey(value: string | undefined): HardwareKeyToken {
  const normalized = value?.toLowerCase();
  if (isHardwareKeyToken(normalized)) return normalized;
  throw new AppError(
    'INVALID_ARGS',
    `hardware-key key must be one of: ${HARDWARE_KEYS.join(', ')}, or ${ANDROID_KEYCODE_PREFIX}<n> with n from 1 to ${MAX_ANDROID_KEYCODE}.`,
  );
}

export function isHardwareKeyToken(value: unknown): value is HardwareKeyToken {
  if (typeof value !== 'string') return false;
  if (isHardwareKey(value)) return true;
  const digits = value.startsWith(ANDROID_KEYCODE_PREFIX)
    ? value.slice(ANDROID_KEYCODE_PREFIX.length)
    : '';
  return /^[1-9]\d{0,9}$/.test(digits) && Number(digits) <= MAX_ANDROID_KEYCODE;
}

function isHardwareKey(value: string): value is HardwareKey {
  return Object.hasOwn(HARDWARE_KEY_DEFINITIONS, value);
}

/** The `KeyEvent` keycode `adb shell input keyevent` sends for the key. */
export function toAndroidHardwareKeycode(key: HardwareKeyToken): number {
  return isHardwareKey(key)
    ? HARDWARE_KEY_DEFINITIONS[key].androidKeycode
    : Number(key.slice(ANDROID_KEYCODE_PREFIX.length));
}
