/**
 * The Linux host-tool surface a request scopes (ADR 0019 host execution).
 *
 * The Linux family drives desktop tools — `xdotool`, `ydotool`, a clipboard tool, a screenshot
 * tool, and the AT-SPI helper — through this vocabulary. Root composition passes a resolved
 * provider back to the Linux plugin without naming its implementation, exactly as it does for the
 * Vega family's CLI adapter, so a request that owns a display decision and a command route hands
 * them to the family instead of the family reaching process globals of its own.
 */

import type { RawSnapshotNode } from '@agent-device/kernel/snapshot';
import type { ClickButton } from './click-button.ts';
import type { ScrollDirection } from './scroll-gesture.ts';
import type { SessionSurface } from './session-surface.ts';

/** The Linux family's display-server vocabulary, from one detector. */
export type LinuxDisplayServer = 'wayland' | 'x11';

/** The input tool one provider resolved, tagged with the display decision it resolved for. */
export type LinuxInputTool = 'xdotool' | 'ydotool';

export type LinuxInputSelection = Readonly<{ tool: LinuxInputTool; display: LinuxDisplayServer }>;

/** The AT-SPI surface one Linux capture reads: the desktop or the frontmost app. */
export type LinuxSnapshotSurface = 'desktop' | 'frontmost-app';

/** What the host answered one Linux tool: its streams and its exit code. */
export type LinuxCommandResult = Readonly<{
  stdout: string;
  stderr: string;
  exitCode: number;
}>;

/** How one Linux tool call runs. */
export type LinuxCommandOptions = Readonly<{
  allowFailure?: boolean;
  timeoutMs?: number;
  signal?: AbortSignal;
  stdin?: string;
}>;

/** Why a process that outlived its launch ended: a start failure, a non-zero exit, or a signal. */
export type LinuxDetachedExit = Readonly<{
  pid: number;
  exitCode?: number;
  signal?: string;
  error?: string;
}>;

/**
 * The desktop-provider parts one request may supply. Each part answers one semantic intent of the
 * Linux interactor, so a caller that owns a surface — a scripted desktop, a display server it
 * drives directly — substitutes it for the family's own tool route without reimplementing the
 * interactor. The command primitives stay mandatory: every Linux tool call goes through them.
 */
export type LinuxToolProvider = Readonly<{
  /** The display decision every local tool selection in this provider shares (#3794). */
  display: Readonly<{ detectDisplayServer(): LinuxDisplayServer }>;
  runCommand(
    cmd: string,
    args: readonly string[],
    options?: LinuxCommandOptions,
  ): Promise<LinuxCommandResult>;
  whichCommand(cmd: string): Promise<boolean>;
  /**
   * Starts a process that outlives the call, with its output discarded, and settles `exited` when
   * it ends: with `error` when it could not start, else with its exit code or signal.
   */
  launchDetached(
    cmd: string,
    args: readonly string[],
  ): Readonly<{ exited: Promise<LinuxDetachedExit> }>;
  /** Waits for interaction pacing between synthesized input steps. */
  sleep(milliseconds: number): Promise<void>;
  desktop: LinuxDesktopProvider;
  clipboard?: LinuxClipboardProvider;
  screenshot?: LinuxScreenshotProvider;
  accessibility?: LinuxAccessibilityProvider;
  input?: LinuxInputProvider;
}>;

export type LinuxDesktopProvider = Readonly<{
  openTarget(target: string): Promise<void>;
  closeApp(app: string): Promise<void>;
}>;

export type LinuxClipboardProvider = Readonly<{
  readText(): Promise<string>;
  writeText(text: string): Promise<void>;
}>;

export type LinuxScreenshotProvider = Readonly<{
  capture(
    outPath: string,
    options?: Readonly<{ fullscreen?: boolean; stabilize?: boolean; surface?: SessionSurface }>,
  ): Promise<void>;
}>;

export type LinuxAccessibilityProvider = Readonly<{
  captureTree(
    surface: LinuxSnapshotSurface,
    options?: Readonly<{
      maxNodes?: number;
      maxDepth?: number;
      maxApps?: number;
      signal?: AbortSignal;
    }>,
  ): Promise<
    Readonly<{
      nodes: readonly RawSnapshotNode[];
      truncated: boolean;
      surface: LinuxSnapshotSurface;
    }>
  >;
}>;

export type LinuxInputProvider = Readonly<{
  click(x: number, y: number, button: ClickButton): Promise<void>;
  doubleClick(x: number, y: number): Promise<void>;
  longPress(x: number, y: number, durationMs: number): Promise<void>;
  drag(x1: number, y1: number, x2: number, y2: number, durationMs: number): Promise<void>;
  scroll(
    direction: ScrollDirection,
    options?: Readonly<{ amount?: number; pixels?: number; durationMs?: number }>,
  ): Promise<void>;
  typeText(text: string, options?: Readonly<{ delayMs?: number }>): Promise<void>;
  /** Sends one combination: `combo` is xdotool keysym notation, `scancodes` ydotool pairs. */
  key(combo: string, scancodes: readonly string[]): Promise<void>;
}>;
