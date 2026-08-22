// The public API vocabulary for the gesture and text-entry commands.

import type { ClickButton } from './click-button.ts';
import type { GesturePointerCount } from './gesture-plan-types.ts';
import type {
  ScrollDirection,
  ScrollInputDirection,
  SwipePattern,
  SwipePreset,
  TransformGestureParams,
} from './scroll-gesture.ts';
import type { SelectorSnapshotCommandOptions } from './client-capture.ts';
import type { DeviceCommandBaseOptions } from './client-connection.ts';
import type { InteractionTarget } from './client-target.ts';

export type RepeatedPressOptions = {
  count?: number;
  intervalMs?: number;
  holdMs?: number;
  jitterPx?: number;
  doubleTap?: boolean;
};

/**
 * Opt-in (#1101): after the action, wait for the UI to go quiet and return the
 * settled diff vs the pre-action tree (`settle` on the result) in the same
 * response. Best-effort — never fails the action. `settleQuietMs` tunes the
 * quiet window (default 500ms); `timeoutMs` bounds the settle wait (default
 * 10s) when `settle` is true. A bare `timeoutMs` without `settle` is ignored
 * for compatibility; `settleQuietMs` still requires `settle`.
 */
export type SettleCommandOptions = {
  settle?: boolean;
  settleQuietMs?: number;
  timeoutMs?: number;
};

export type ClickOptions = DeviceCommandBaseOptions &
  SelectorSnapshotCommandOptions &
  InteractionTarget &
  RepeatedPressOptions &
  SettleCommandOptions & {
    button?: ClickButton;
    /**
     * Opt-in (#1047): return cheap post-action evidence (AX digest, node counts,
     * changedFromBefore) in the response instead of requiring a follow-up
     * snapshot to confirm the action had an effect.
     */
    verify?: boolean;
  };

export type PressOptions = DeviceCommandBaseOptions &
  SelectorSnapshotCommandOptions &
  InteractionTarget &
  RepeatedPressOptions &
  SettleCommandOptions & {
    verify?: boolean;
  };

export type LongPressOptions = DeviceCommandBaseOptions &
  SelectorSnapshotCommandOptions &
  InteractionTarget &
  SettleCommandOptions & {
    durationMs?: number;
  };

export type HoverOptions = DeviceCommandBaseOptions &
  SelectorSnapshotCommandOptions &
  InteractionTarget &
  SettleCommandOptions;

export type SwipeOptions = DeviceCommandBaseOptions & {
  from: { x: number; y: number };
  to: { x: number; y: number };
  count?: number;
  pauseMs?: number;
  pattern?: SwipePattern;
};

export type PanOptions = DeviceCommandBaseOptions & {
  x: number;
  y: number;
  dx: number;
  dy: number;
  pointerCount?: GesturePointerCount;
  durationMs?: number;
};

export type DragOptions = DeviceCommandBaseOptions & {
  source: string;
  destination: string;
  sourceHoldMs?: number;
  moveMs?: number;
  destinationHoldMs?: number;
};

export type FlingOptions = DeviceCommandBaseOptions & {
  direction: ScrollDirection;
  x: number;
  y: number;
  distance?: number;
};

export type SwipeGestureOptions = DeviceCommandBaseOptions & {
  preset: SwipePreset;
};

export type FocusOptions = DeviceCommandBaseOptions & {
  x: number;
  y: number;
};

export type TypeTextOptions = DeviceCommandBaseOptions & {
  text: string;
  delayMs?: number;
};

export type FillOptions = DeviceCommandBaseOptions &
  SelectorSnapshotCommandOptions &
  InteractionTarget &
  SettleCommandOptions & {
    text: string;
    delayMs?: number;
    /** Publish this fill value as `${VAR}` when script recording is armed. */
    recordAs?: string;
    verify?: boolean;
  };

export type PinchOptions = DeviceCommandBaseOptions & {
  scale: number;
  x?: number;
  y?: number;
};

export type RotateGestureOptions = DeviceCommandBaseOptions & {
  degrees: number;
  x?: number;
  y?: number;
};

export type TransformGestureOptions = DeviceCommandBaseOptions & TransformGestureParams;

export type ScrollOptions = DeviceCommandBaseOptions &
  SettleCommandOptions & {
    direction: ScrollInputDirection;
    amount?: number;
    pixels?: number;
    durationMs?: number;
  };
