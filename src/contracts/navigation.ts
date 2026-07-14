import type { BackMode } from './back-mode.ts';
import type { DeviceRotation } from './device-rotation.ts';
import type { TvRemoteButton } from './tv-remote.ts';

/**
 * Closed results of the navigation/global action commands. Each mirrors the
 * dispatch handler's literal return EXACTLY (src/core/dispatch.ts
 * `DISPATCH_HANDLERS`): a fixed `action` discriminant plus the always-present
 * `successText` message (the handlers always pass a non-empty message, so it is
 * required here). The handlers spread nothing else, so the shapes are closed —
 * consistent with the `viewport` contract, the generic-dispatch Android
 * dialog-recovery `warning` annotation is intentionally not part of the contract.
 */

/** `home` — `{ action: 'home', message: 'Home' }`. */
export type HomeCommandResult = {
  action: 'home';
  message: string;
};

/** `back` — `{ action: 'back', mode, message: 'Back' }`; `mode` defaults to `'in-app'`. */
export type BackCommandResult = {
  action: 'back';
  mode: BackMode;
  message: string;
};

/** `orientation` — `{ action: 'orientation', orientation, message: 'Rotated to <orientation>' }`. */
export type OrientationCommandResult = {
  action: 'orientation';
  orientation: DeviceRotation;
  message: string;
};

/**
 * @deprecated The `rotate` command was renamed to `orientation`. This is the
 * legacy response contract (`action: 'rotate'`) that shipped in v0.18/v0.19,
 * retained for existing SDK consumers until the next major version. New code
 * should use {@link OrientationCommandResult}.
 */
export type RotateCommandResult = {
  action: 'rotate';
  orientation: DeviceRotation;
  message: string;
};

/** `app-switcher` — `{ action: 'app-switcher', message: 'Opened app switcher' }`. */
export type AppSwitcherCommandResult = {
  action: 'app-switcher';
  message: string;
};

/** `tv-remote` — `{ action: 'tv-remote', button, durationMs?, message }`. */
export type TvRemoteCommandResult = {
  action: 'tv-remote';
  button: TvRemoteButton;
  durationMs?: number;
  message: string;
};
