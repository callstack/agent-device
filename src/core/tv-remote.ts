import { AppError } from '../kernel/errors.ts';

type TvRemoteDurationMode = 'exact' | 'longpress';

type TvRemoteButtonDefinition = {
  aliases: readonly string[];
  androidKeyevent: string;
  appleRemoteButton: string;
  durationMode: {
    android: TvRemoteDurationMode;
    apple: TvRemoteDurationMode;
  };
};

const TV_REMOTE_BUTTON_DEFINITIONS = {
  up: {
    aliases: [],
    androidKeyevent: 'KEYCODE_DPAD_UP',
    appleRemoteButton: 'up',
    durationMode: { android: 'longpress', apple: 'exact' },
  },
  down: {
    aliases: [],
    androidKeyevent: 'KEYCODE_DPAD_DOWN',
    appleRemoteButton: 'down',
    durationMode: { android: 'longpress', apple: 'exact' },
  },
  left: {
    aliases: [],
    androidKeyevent: 'KEYCODE_DPAD_LEFT',
    appleRemoteButton: 'left',
    durationMode: { android: 'longpress', apple: 'exact' },
  },
  right: {
    aliases: [],
    androidKeyevent: 'KEYCODE_DPAD_RIGHT',
    appleRemoteButton: 'right',
    durationMode: { android: 'longpress', apple: 'exact' },
  },
  select: {
    aliases: ['ok', 'center', 'enter'],
    androidKeyevent: 'KEYCODE_DPAD_CENTER',
    appleRemoteButton: 'select',
    durationMode: { android: 'longpress', apple: 'exact' },
  },
  menu: {
    aliases: [],
    androidKeyevent: 'KEYCODE_MENU',
    appleRemoteButton: 'menu',
    durationMode: { android: 'longpress', apple: 'exact' },
  },
  home: {
    aliases: [],
    androidKeyevent: 'KEYCODE_HOME',
    appleRemoteButton: 'home',
    durationMode: { android: 'longpress', apple: 'exact' },
  },
  back: {
    aliases: [],
    androidKeyevent: 'KEYCODE_BACK',
    appleRemoteButton: 'menu',
    durationMode: { android: 'longpress', apple: 'exact' },
  },
} as const satisfies Record<string, TvRemoteButtonDefinition>;

export const TV_REMOTE_BUTTONS = Object.keys(
  TV_REMOTE_BUTTON_DEFINITIONS,
) as (keyof typeof TV_REMOTE_BUTTON_DEFINITIONS)[];

export const TV_REMOTE_BUTTON_USAGE = `<${TV_REMOTE_BUTTONS.join('|')}>`;

export type TvRemoteButton = (typeof TV_REMOTE_BUTTONS)[number];

export type AppleTvRemoteButton =
  (typeof TV_REMOTE_BUTTON_DEFINITIONS)[TvRemoteButton]['appleRemoteButton'];

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

export function tvRemoteDurationMode(
  platform: keyof TvRemoteButtonDefinition['durationMode'],
): TvRemoteDurationMode {
  return TV_REMOTE_BUTTON_DEFINITIONS.select.durationMode[platform];
}

const TV_REMOTE_BUTTON_ALIAS_MAP = new Map<string, TvRemoteButton>(
  TV_REMOTE_BUTTONS.flatMap((button) =>
    TV_REMOTE_BUTTON_DEFINITIONS[button].aliases.map((alias) => [alias, button] as const),
  ),
);
