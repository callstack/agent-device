import type { BackMode } from './back-mode.ts';
import type { DeviceRotation } from './device-rotation.ts';
import type { SettleObservation } from './interaction.ts';
import type { TvRemoteButton } from './tv-remote.ts';

/**
 * Closed results of the navigation/global action commands. Each mirrors its
 * request-scoped runtime's literal return: a fixed `action` discriminant plus the always-present
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

/**
 * `back` — `{ action: 'back', mode, message: 'Back' }`; `mode` defaults to
 * `'in-app'`. The one field the generic route may add on top of the dispatch
 * runtime's literal return: `settle`, the opt-in `--settle` observation
 * (#1638), attached after the command by the generic dispatcher.
 */
export type BackCommandResult = {
  action: 'back';
  mode: BackMode;
  message: string;
  settle?: SettleObservation;
};

/**
 * `orientation` — `{ action: 'orientation', orientation, message: 'Rotated to <orientation>' }`.
 *
 * An owner that reports no resulting rotation is not evidence that the device
 * rotated. That case keeps the requested `orientation` for compatibility, but
 * discloses `confirmed: false` plus a `warning`, and names the request in
 * `message` (`Rotation requested: <orientation> (unconfirmed)`).
 */
export type OrientationCommandResult = {
  action: 'orientation';
  orientation: DeviceRotation;
  message: string;
  confirmed?: boolean;
  warning?: string;
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
