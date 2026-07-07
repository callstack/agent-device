import { AppError } from '../kernel/errors.ts';

export const TV_REMOTE_BUTTONS = [
  'up',
  'down',
  'left',
  'right',
  'select',
  'menu',
  'home',
  'back',
] as const;

export type TvRemoteButton = (typeof TV_REMOTE_BUTTONS)[number];

export type AppleTvRemoteButton = Exclude<TvRemoteButton, 'back'>;

export function parseTvRemoteButton(value: string | undefined): TvRemoteButton {
  const normalized = value?.toLowerCase();
  if (isTvRemoteButton(normalized)) return normalized;
  throw new AppError(
    'INVALID_ARGS',
    `tv-remote button must be one of: ${TV_REMOTE_BUTTONS.join(', ')}`,
  );
}

export function isTvRemoteButton(value: unknown): value is TvRemoteButton {
  return typeof value === 'string' && TV_REMOTE_BUTTONS.includes(value as TvRemoteButton);
}

export function toAppleTvRemoteButton(button: TvRemoteButton): AppleTvRemoteButton {
  return button === 'back' ? 'menu' : button;
}
