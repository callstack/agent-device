/**
 * The Linux host-tool vocabulary the family drives its desktop with (ADR 0019 host execution).
 *
 * The Linux family runs desktop tools — `xdotool`, `ydotool`, a clipboard tool, a screenshot tool,
 * and the AT-SPI helper — through this shape. One instance answers one `PlatformHost`: the toolbox
 * built from the host the plugin was set up with supplies the command route, and the display
 * decision comes from that host's environment. Nothing outside this package builds or receives it.
 */

import type { RawSnapshotNode } from '@agent-device/kernel/snapshot';
import type { DetachedCommandExit } from '@agent-device/contracts/platform-runtime-host';
import type { ClickButton } from '@agent-device/contracts/click-button';
import type { ScrollDirection } from '@agent-device/contracts/scroll-gesture';
import type { SessionSurface } from '@agent-device/contracts/session';

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

/**
 * The Linux desktop surface one setup drives: the command primitives, read from the family's own
 * host, and the semantic parts built on them. `input` is the only optional part because the
 * family's own xdotool/ydotool synthesis is the fallback for it; every other part is mandatory,
 * because the interactor reads each one on a plain Linux request.
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
  ): Readonly<{ exited: Promise<DetachedCommandExit> }>;
  /** Waits for interaction pacing between synthesized input steps. */
  sleep(milliseconds: number): Promise<void>;
  desktop: LinuxDesktopProvider;
  clipboard: LinuxClipboardProvider;
  screenshot: LinuxScreenshotProvider;
  accessibility: LinuxAccessibilityProvider;
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
