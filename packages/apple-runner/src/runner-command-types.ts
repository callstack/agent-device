// The wire shapes of the commands the host sends the XCTest runner. Types only, so a module that
// reads them loads nothing; runner-contract.ts re-exports them beside the behavior that builds them.
import type { DeviceRotation } from '@agent-device/contracts/device';
import type { SnapshotPreferredBackend } from '@agent-device/kernel/snapshot';
import type { ClickButton } from '@agent-device/contracts/click-button';
import type {
  CoordinateTapTextInputEvidence,
  ElementSelectorKey,
} from '@agent-device/contracts/interactor-types';
import type { GesturePlan } from '@agent-device/contracts/gesture-plan-types';
import type { ScrollDirection } from '@agent-device/contracts/scroll-gesture';
import type { ScrollReleaseBehavior } from '@agent-device/contracts/scroll-command';

export type RunnerCommand = {
  coordinateTapTextInputEvidence?: CoordinateTapTextInputEvidence;
  command:
    | 'tap'
    | 'mouseClick'
    | 'longPress'
    | 'drag'
    | 'remotePress'
    | 'type'
    | 'swipe'
    // Fused frame-resolve + drag scroll (non-tvOS). Intentionally mutating in runner command
    // traits so it routes through single-send, command-id tracking, and lost-response status
    // recovery like other gestures.
    | 'scroll'
    // macOS-only frame-resolve + desktop wheel scroll. Kept distinct from `scroll` so mobile
    // touch drag semantics remain stable.
    | 'desktopScroll'
    | 'findText'
    | 'querySelector'
    | 'readText'
    | 'snapshot'
    | 'accessibilityAudit'
    | 'screenshot'
    | 'backInApp'
    | 'home'
    | 'rotate'
    | 'gesture'
    | 'gestureViewport'
    | 'appSwitcher'
    | 'actionButton'
    | 'volumeUp'
    | 'volumeDown'
    // Shows or dismisses the lock screen, and answers only once SpringBoard reports that state.
    | 'lockScreen'
    | 'unlockScreen'
    | 'keyboardDismiss'
    | 'keyboardReturn'
    // Reads the software keyboard and the focused field's return key. A read: it reports what is on
    // screen, and presses nothing.
    | 'keyboardStatus'
    | 'alert'
    | 'sequence'
    | 'recordStart'
    | 'recordStop'
    | 'status'
    | 'uptime'
    // The session app's XCUIApplication.state by name. A lifecycle read: it skips the activation
    // preflight, so it reports the state the app is in rather than the one a repair leaves.
    | 'appState'
    // Reads the Simulator AX bridge tree in the runner process, off its journal and command queue.
    | 'snapshotBridge'
    // Sets the device's general pasteboard from the runner's own process: a simulator's
    // `simctl pbcopy` only promises its data from a process that exits before anything reads it.
    | 'pasteboardWrite'
    | 'activate'
    | 'terminate'
    | 'targetReset'
    | 'shutdown';
  commandId?: string;
  statusCommandId?: string;
  appBundleId?: string;
  text?: string;
  selectorKey?: ElementSelectorKey;
  selectorValue?: string;
  /** `querySelector` only: answer the lean per-element hittability read instead of a node. */
  hittabilityProbe?: boolean;
  allowNonHittableCoordinateFallback?: boolean;
  delayMs?: number;
  textEntryMode?: 'append' | 'replace';
  action?: 'get' | 'accept' | 'dismiss';
  includesKeyboard?: boolean;
  displayViewport?: boolean;
  x?: number;
  y?: number;
  button?: ClickButton;
  remoteButton?: 'select' | 'menu' | 'home' | 'up' | 'down' | 'left' | 'right';
  x2?: number;
  y2?: number;
  durationMs?: number;
  /** Remaining request budget for runner work that performs bounded XCTest queries. */
  timeoutMs?: number;
  direction?: ScrollDirection;
  amount?: number;
  pixels?: number;
  scrollReleaseBehavior?: ScrollReleaseBehavior;
  orientation?: DeviceRotation;
  /** Canonical pointer samples planned by the portable gesture runtime. */
  gesturePlan?: GesturePlan;
  outPath?: string;
  fps?: number;
  interactiveOnly?: boolean;
  /** Pin the snapshot capture backend (same-backend evidence probes). */
  preferredBackend?: SnapshotPreferredBackend;
  /**
   * Read accessibility custom actions for merged leaves. Opt-in: each element
   * costs its own AX round trip, and the runner pins the private-AX backend
   * because no other backend can carry them.
   */
  customActions?: boolean;
  observeOnly?: boolean;
  depth?: number;
  scope?: string;
  raw?: boolean;
  fullscreen?: boolean;
  inlineScreenshot?: boolean;
  synthesized?: boolean;
  /**
   * The lit panel's display and native box in points, sent only for a multi-panel device on a
   * command that resolves a screen (ADR 0025).
   */
  litPanel?: { displayId: number; widthPt: number; heightPt: number };
  sequenceOrientation?: RunnerSequenceOrientation;
  steps?: RunnerSequenceStep[];
  snapshotBridge?: RunnerSnapshotBridgeRequest;
};

/**
 * One request to the Simulator AX bridge reader that the runner serves. `target` names the foreground
 * process of `appBundleId`. `describe` reads that process's tree under the guest bridge's own bounds,
 * and refuses a process other than `expectedPid` and `expectedProcessStartTime` as a stale target, so
 * it cannot be sent without them.
 */
export type RunnerSnapshotBridgeRequest =
  | { verb: 'target'; requestId: string; maxDurationMs?: number }
  | {
      verb: 'describe';
      requestId: string;
      generation: string;
      expectedPid: number;
      expectedProcessStartTime: string;
      maxDepth?: number;
      maxNodes?: number;
      maxDurationMs?: number;
      maxResponseBytes?: number;
      nativeLevelsHint?: number;
      /**
       * System surface host executables whose running process on this Simulator refuses the read with
       * `system-surface-host-present`. The runner names its own Simulator.
       */
      surfaceHostExecutables?: readonly string[];
    };

/**
 * One allowlisted coordinate gesture step inside a fused `sequence` runner command.
 * The kind set is intentionally narrow (tap/doubleTap/longPress) and validated on both the
 * daemon and runner sides — see `parseRunnerSequenceResult` in runner-contract.ts (the single
 * interpretation point).
 */
export type RunnerSequenceStep = {
  kind: 'tap' | 'doubleTap' | 'longPress';
  x: number;
  y: number;
  durationMs?: number;
  pauseMs?: number;
  /**
   * For `tap` steps on iOS non-tv: use the synthesized HID tap (synthesizedTapAt) fast path
   * instead of the drag-based XCUICoordinate tapAt, matching the individual `tap` command.
   */
  synthesized?: boolean;
};

export type RunnerSequenceOrientation = 1 | 2 | 3 | 4;
