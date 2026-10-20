import { AppError } from '@agent-device/kernel/errors';

type TvRemoteDurationMode = 'exact' | 'longpress';

type TvRemoteButtonDefinition = {
  aliases: readonly string[];
  androidKeyevent: string;
  appleRemoteButton?: string;
  vegaKey?: string;
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
  'volume-up': { aliases: [], androidKeyevent: '24' },
  'volume-down': { aliases: [], androidKeyevent: '25' },
  mute: { aliases: [], androidKeyevent: '164' },
  power: { aliases: [], androidKeyevent: '26' },
  sleep: { aliases: [], androidKeyevent: '223' },
  wake: { aliases: [], androidKeyevent: '224' },
  'media-play-pause': { aliases: [], androidKeyevent: '85' },
  'media-next': { aliases: [], androidKeyevent: '87' },
  'media-previous': { aliases: [], androidKeyevent: '88' },
  'media-rewind': { aliases: [], androidKeyevent: '89' },
  'media-fast-forward': { aliases: [], androidKeyevent: '90' },
  'channel-up': { aliases: [], androidKeyevent: '166' },
  'channel-down': { aliases: [], androidKeyevent: '167' },
  'last-channel': { aliases: [], androidKeyevent: '229' },
  guide: { aliases: [], androidKeyevent: '172' },
  info: { aliases: [], androidKeyevent: '165' },
  captions: { aliases: [], androidKeyevent: '175' },
  'tv-input': { aliases: [], androidKeyevent: '178' },
  'color-red': { aliases: [], androidKeyevent: '183' },
  'color-green': { aliases: [], androidKeyevent: '184' },
  'color-yellow': { aliases: [], androidKeyevent: '185' },
  'color-blue': { aliases: [], androidKeyevent: '186' },
} as const satisfies Record<string, TvRemoteButtonDefinition>;

export const TV_REMOTE_BUTTONS = Object.keys(
  TV_REMOTE_BUTTON_DEFINITIONS,
) as (keyof typeof TV_REMOTE_BUTTON_DEFINITIONS)[];

const ANDROID_KEYCODE_PREFIX = 'android-keycode:';
const MAX_ANDROID_KEYCODE = 2_147_483_647;

export const TV_REMOTE_BUTTON_USAGE = `<${TV_REMOTE_BUTTONS.join('|')}|android-keycode:<n>>`;

type NamedTvRemoteButton = (typeof TV_REMOTE_BUTTONS)[number];

export type TvRemoteButton = NamedTvRemoteButton | `android-keycode:${number}`;

export type AppleTvRemoteButton = Extract<
  (typeof TV_REMOTE_BUTTON_DEFINITIONS)[NamedTvRemoteButton],
  { appleRemoteButton: string }
>['appleRemoteButton'];

export type VegaTvRemoteKey = Extract<
  (typeof TV_REMOTE_BUTTON_DEFINITIONS)[NamedTvRemoteButton],
  { vegaKey: string }
>['vegaKey'];

export function parseTvRemoteButton(value: string | undefined): TvRemoteButton {
  const normalized = value?.toLowerCase();
  if (isNamedTvRemoteButton(normalized) || isAndroidKeycode(normalized)) return normalized;
  const canonical = normalized ? TV_REMOTE_BUTTON_ALIAS_MAP.get(normalized) : undefined;
  if (canonical) return canonical;
  throw new AppError(
    'INVALID_ARGS',
    `tv-remote button must be one of: ${TV_REMOTE_BUTTONS.join(', ')}, or android-keycode:<n> with n from 1 to ${MAX_ANDROID_KEYCODE}.`,
  );
}

function isNamedTvRemoteButton(value: unknown): value is NamedTvRemoteButton {
  return typeof value === 'string' && Object.hasOwn(TV_REMOTE_BUTTON_DEFINITIONS, value);
}

function isAndroidKeycode(value: unknown): value is `android-keycode:${number}` {
  if (typeof value !== 'string' || !value.startsWith(ANDROID_KEYCODE_PREFIX)) return false;
  const digits = value.slice(ANDROID_KEYCODE_PREFIX.length);
  return /^[1-9]\d{0,9}$/.test(digits) && Number(digits) <= MAX_ANDROID_KEYCODE;
}

export function tvRemoteButtonsForPlatform(platform: 'apple' | 'vega'): readonly TvRemoteButton[] {
  const key = platform === 'apple' ? 'appleRemoteButton' : 'vegaKey';
  return TV_REMOTE_BUTTONS.filter((button) => key in TV_REMOTE_BUTTON_DEFINITIONS[button]);
}

export function toAppleTvRemoteButton(button: TvRemoteButton): AppleTvRemoteButton {
  const definition = isNamedTvRemoteButton(button)
    ? TV_REMOTE_BUTTON_DEFINITIONS[button]
    : undefined;
  if (definition && 'appleRemoteButton' in definition) return definition.appleRemoteButton;
  throw unsupportedTvRemoteButton(button, 'tvOS');
}

export function toAndroidTvRemoteKeyevent(button: TvRemoteButton): string {
  return isNamedTvRemoteButton(button)
    ? TV_REMOTE_BUTTON_DEFINITIONS[button].androidKeyevent
    : button.slice(ANDROID_KEYCODE_PREFIX.length);
}

export function toVegaTvRemoteKey(button: TvRemoteButton): VegaTvRemoteKey {
  const definition = isNamedTvRemoteButton(button)
    ? TV_REMOTE_BUTTON_DEFINITIONS[button]
    : undefined;
  if (definition && 'vegaKey' in definition) return definition.vegaKey;
  throw unsupportedTvRemoteButton(button, 'Vega OS');
}

function unsupportedTvRemoteButton(button: TvRemoteButton, platform: string): AppError {
  return new AppError(
    'UNSUPPORTED_OPERATION',
    `TV remote button ${button} is not supported on ${platform}.`,
    {
      reason: 'unsupported-platform-leaf',
    },
  );
}

export function tvRemoteDurationMode(
  platform: keyof typeof TV_REMOTE_DURATION_MODE,
): TvRemoteDurationMode {
  return TV_REMOTE_DURATION_MODE[platform];
}

const TV_REMOTE_BUTTON_ALIAS_MAP = new Map<string, NamedTvRemoteButton>(
  TV_REMOTE_BUTTONS.flatMap((button) =>
    TV_REMOTE_BUTTON_DEFINITIONS[button].aliases.map((alias) => [alias, button] as const),
  ),
);
