// The public API vocabulary for the system and diagnostic commands (wait, alert, keyboard, clipboard, doctor…).

import type { AlertAction } from './alert-contract.ts';
import type { BackMode } from './back-mode.ts';
import type { SelectorSnapshotCommandOptions } from './client-capture.ts';
import type { DeviceCommandBaseOptions } from './client-connection.ts';
import type { SettleCommandOptions } from './client-gesture.ts';
import type { OrientationRequest, SetFoldPoseInput } from './device-rotation.ts';
import type { TelephonyEventInput } from './telephony-input.ts';
import type { TvRemoteButton } from './tv-remote.ts';

export type WaitCommandTarget =
  | {
      durationMs: number;
      text?: never;
      ref?: never;
      selector?: never;
      absent?: never;
      stable?: never;
      quietMs?: never;
      timeoutMs?: never;
    }
  | (SelectorSnapshotCommandOptions & {
      text: string;
      durationMs?: never;
      ref?: never;
      selector?: never;
      absent?: never;
      stable?: never;
      quietMs?: never;
      timeoutMs?: number;
    })
  | (SelectorSnapshotCommandOptions & {
      ref: string;
      durationMs?: never;
      text?: never;
      selector?: never;
      absent?: never;
      stable?: never;
      quietMs?: never;
      timeoutMs?: number;
    })
  | (SelectorSnapshotCommandOptions & {
      selector: string;
      durationMs?: never;
      text?: never;
      ref?: never;
      absent?: never;
      stable?: never;
      quietMs?: never;
      timeoutMs?: number;
    })
  | (SelectorSnapshotCommandOptions & {
      absent: string;
      durationMs?: never;
      text?: never;
      ref?: never;
      selector?: never;
      stable?: never;
      quietMs?: never;
      timeoutMs?: number;
    })
  | (SelectorSnapshotCommandOptions & {
      stable: true;
      durationMs?: never;
      text?: never;
      ref?: never;
      selector?: never;
      absent?: never;
      quietMs?: number;
      timeoutMs?: number;
    });

export type WaitCommandOptions = DeviceCommandBaseOptions & WaitCommandTarget;

export type AlertCommandOptions = DeviceCommandBaseOptions & {
  action?: AlertAction;
  timeoutMs?: number;
};

export type AppStateCommandOptions = DeviceCommandBaseOptions;

/** #1638: `back` carries the shared `--settle` triple, and its result may carry the settled diff. */
export type BackCommandOptions = DeviceCommandBaseOptions & {
  mode?: BackMode;
} & SettleCommandOptions;

export type HomeCommandOptions = DeviceCommandBaseOptions;

export type OrientationCommandOptions = DeviceCommandBaseOptions & {
  /** A fixed rotation, or `auto` to hand rotation back to the sensor (ADB-backed Android only). */
  orientation: OrientationRequest;
};

export type FoldCommandOptions = DeviceCommandBaseOptions & SetFoldPoseInput;

export type AppSwitcherCommandOptions = DeviceCommandBaseOptions;

export type ActionButtonCommandOptions = DeviceCommandBaseOptions;

export type TvRemoteCommandOptions = DeviceCommandBaseOptions & {
  button: TvRemoteButton;
  durationMs?: number;
};

export type TelephonyCommandOptions = DeviceCommandBaseOptions & TelephonyEventInput;

export type KeyboardCommandOptions = DeviceCommandBaseOptions & {
  action?: 'status' | 'dismiss' | 'enter' | 'return';
};

export type ClipboardCommandOptions =
  | (DeviceCommandBaseOptions & {
      action: 'read';
    })
  | (DeviceCommandBaseOptions & {
      action: 'write';
      text: string;
    });

export type ReactNativeCommandOptions = DeviceCommandBaseOptions & {
  action: 'dismiss-overlay';
};

export type PrepareCommandOptions = DeviceCommandBaseOptions & {
  action: 'ios-runner';
  timeoutMs?: number;
};

export type DoctorCommandOptions = DeviceCommandBaseOptions & {
  targetApp?: string;
  remote?: boolean;
};

export type ViewportCommandOptions = DeviceCommandBaseOptions & {
  width: number;
  height: number;
};
