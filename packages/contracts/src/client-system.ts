// The public API vocabulary for the system and diagnostic commands (wait, alert, keyboard, clipboard, doctor…).

import type { AlertAction } from './alert-contract.ts';
import type { SelectorSnapshotCommandOptions } from './client-capture.ts';
import type { DeviceCommandBaseOptions } from './client-connection.ts';

export type WaitCommandTarget =
  | {
      durationMs: number;
      text?: never;
      ref?: never;
      selector?: never;
      stable?: never;
      quietMs?: never;
      timeoutMs?: never;
    }
  | (SelectorSnapshotCommandOptions & {
      text: string;
      durationMs?: never;
      ref?: never;
      selector?: never;
      stable?: never;
      quietMs?: never;
      timeoutMs?: number;
    })
  | (SelectorSnapshotCommandOptions & {
      ref: string;
      durationMs?: never;
      text?: never;
      selector?: never;
      stable?: never;
      quietMs?: never;
      timeoutMs?: number;
    })
  | (SelectorSnapshotCommandOptions & {
      selector: string;
      durationMs?: never;
      text?: never;
      ref?: never;
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
      quietMs?: number;
      timeoutMs?: number;
    });

export type WaitCommandOptions = DeviceCommandBaseOptions & WaitCommandTarget;

export type AlertCommandOptions = DeviceCommandBaseOptions & {
  action?: AlertAction;
  timeoutMs?: number;
};

export type AppStateCommandOptions = DeviceCommandBaseOptions;

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
