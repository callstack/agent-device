import type { ClickButton } from '@agent-device/contracts/click-button';
import type { ScrollDirection } from '@agent-device/contracts/scroll-gesture';
import { AppError } from '@agent-device/kernel/errors';
import {
  runCmd,
  whichCmd,
  type ExecOptions,
  type ExecResult,
  commandHostEnvironment,
} from '@agent-device/host-kit/command';
import { emitDiagnostic } from '@agent-device/host-kit/diagnostics';
import { sleep } from '@agent-device/host-kit/retry';

import { createScopedProvider } from '@agent-device/kernel/scoped-provider';
import type { HostEnvironment } from '@agent-device/kernel/source-value';

import type {
  LinuxAccessibilityTree,
  LinuxSnapshotSurface,
  LinuxTraversalOptions,
} from './accessibility-types.ts';
import {
  createLinuxDisplayConfig,
  detectLinuxDisplayServer,
  type LinuxDisplayConfig,
} from './display.ts';

export type LinuxToolCommandExecutor = (
  cmd: string,
  args: string[],
  options?: ExecOptions,
) => Promise<ExecResult>;

export type LinuxToolAvailabilityChecker = (cmd: string) => Promise<boolean>;

export type LinuxDesktopProvider = {
  openTarget(target: string): Promise<void>;
  closeApp(app: string): Promise<void>;
};

export type LinuxClipboardProvider = {
  readText(): Promise<string>;
  writeText(text: string): Promise<void>;
};

export type LinuxScreenshotOptions = {
  fullscreen?: boolean;
  stabilize?: boolean;
  surface?: string;
};

export type LinuxScreenshotProvider = {
  capture(outPath: string, options?: LinuxScreenshotOptions): Promise<void>;
};

export type LinuxAccessibilityProvider = {
  captureTree(
    surface: LinuxSnapshotSurface,
    options?: LinuxTraversalOptions,
  ): Promise<LinuxAccessibilityTree>;
};

export type LinuxPointerButton = ClickButton;

export type LinuxInputProvider = {
  click(x: number, y: number, button: LinuxPointerButton): Promise<void>;
  doubleClick(x: number, y: number): Promise<void>;
  longPress(x: number, y: number, durationMs: number): Promise<void>;
  drag(x1: number, y1: number, x2: number, y2: number, durationMs: number): Promise<void>;
  scroll(
    direction: ScrollDirection,
    options?: { amount?: number; pixels?: number; durationMs?: number },
  ): Promise<void>;
  typeText(text: string, options?: { delayMs?: number }): Promise<void>;
  key(combo: string, scancodes: string[]): Promise<void>;
};

export type LinuxToolProvider = {
  /** The bound display decision every local tool selection in this provider shares (#3794). */
  display: LinuxDisplayConfig;
  runCommand: LinuxToolCommandExecutor;
  whichCommand: LinuxToolAvailabilityChecker;
  desktop: LinuxDesktopProvider;
  clipboard?: LinuxClipboardProvider;
  screenshot?: LinuxScreenshotProvider;
  accessibility?: LinuxAccessibilityProvider;
  input?: LinuxInputProvider;
};

const whichOnPath = async (cmd: string): Promise<boolean> =>
  await whichCmd(cmd, commandHostEnvironment().env);

/** A provider under construction; only the display decision is required up front. */
type LinuxToolProviderParts = { display: LinuxDisplayConfig } & Partial<LinuxToolProvider>;

/** Adds the local parts a partial provider omits; every part then belongs to this instance. */
function completeLocalLinuxToolProvider(provider: LinuxToolProviderParts): LinuxToolProvider {
  const runCommand = provider.runCommand ?? runCmd;
  const whichCommand = provider.whichCommand ?? whichOnPath;
  const display = provider.display;
  return {
    runCommand,
    whichCommand,
    display,
    desktop: provider.desktop ?? createLocalLinuxDesktopProvider(runCommand, whichCommand),
    clipboard:
      provider.clipboard ?? createLocalLinuxClipboardProvider(runCommand, whichCommand, display),
    screenshot:
      provider.screenshot ?? createLocalLinuxScreenshotProvider(runCommand, whichCommand, display),
    ...(provider.accessibility ? { accessibility: provider.accessibility } : {}),
    ...(provider.input ? { input: provider.input } : {}),
  };
}

/**
 * Builds a local provider that reads its configuration from `host`, never from the ambient one:
 * one provider instance per composing runtime, owning its display decision (#3794).
 */
export function createLocalLinuxToolProvider(
  options: { host: HostEnvironment } & Partial<LinuxToolProvider>,
): LinuxToolProvider {
  const { host, ...provider } = options;
  return completeLocalLinuxToolProvider({
    ...provider,
    display: provider.display ?? createLinuxDisplayConfig(host),
  });
}

/**
 * The fallback for callers outside every composed runtime (standalone leaf calls, scripts that
 * name no host): it reads the display decision from the command host of the call, like the
 * ambient read it replaces. A composed runtime binds its own host at `createLinuxInteractor`, so
 * its display decision never comes from here (#3794).
 */
const localLinuxToolProvider = completeLocalLinuxToolProvider({
  runCommand: runCmd,
  whichCommand: whichOnPath,
  display: {
    detectDisplayServer: () => detectLinuxDisplayServer(commandHostEnvironment().env),
  },
});

const linuxToolProviderScope = createScopedProvider(
  localLinuxToolProvider,
  completeLocalLinuxToolProvider,
);

export function resolveLinuxToolProvider(provider?: LinuxToolProvider): LinuxToolProvider {
  return linuxToolProviderScope.resolve(provider);
}

export function hasScopedLinuxToolProvider(): boolean {
  return linuxToolProviderScope.hasScope();
}

export async function withLinuxToolProvider<T>(
  provider: LinuxToolProvider | undefined,
  fn: () => Promise<T>,
): Promise<T> {
  return await linuxToolProviderScope.run(provider, fn);
}

export async function runLinuxToolCommand(
  cmd: string,
  args: string[],
  options?: ExecOptions,
): Promise<ExecResult> {
  return await resolveLinuxToolProvider().runCommand(cmd, args, options);
}

function createLocalLinuxDesktopProvider(
  runCommand: LinuxToolCommandExecutor,
  whichCommand: LinuxToolAvailabilityChecker,
): LinuxDesktopProvider {
  return {
    async openTarget(target) {
      if (target.includes('://') || target.startsWith('/')) {
        await runCommand('xdg-open', [target]);
        return;
      }

      if (await whichCommand(target)) {
        runCommand(target, [], { allowFailure: true }).catch((error) => {
          emitDiagnostic({
            level: 'warn',
            phase: 'linux_app_launch',
            data: { app: target, error: String(error) },
          });
        });
        await sleep(500);
        return;
      }

      await runCommand('xdg-open', [target], { allowFailure: true });
    },
    async closeApp(app) {
      if (await whichCommand('wmctrl')) {
        await runCommand('wmctrl', ['-c', app], { allowFailure: true });
        return;
      }

      await runCommand('pkill', ['-x', app], { allowFailure: true });
    },
  };
}

function createLocalLinuxClipboardProvider(
  runCommand: LinuxToolCommandExecutor,
  whichCommand: LinuxToolAvailabilityChecker,
  display: LinuxDisplayConfig,
): LinuxClipboardProvider {
  return {
    async readText() {
      const tool = await resolveLocalLinuxTool(whichCommand, display, LOCAL_CLIPBOARD_TOOLS);
      const command = LOCAL_CLIPBOARD_READ_COMMANDS[tool];
      return (await runCommand(command.cmd, command.args, command.options)).stdout;
    },
    async writeText(text) {
      const tool = await resolveLocalLinuxTool(whichCommand, display, LOCAL_CLIPBOARD_TOOLS);
      const command = LOCAL_CLIPBOARD_WRITE_COMMANDS[tool](text);
      await runCommand(command.cmd, command.args, command.options);
    },
  };
}

function createLocalLinuxScreenshotProvider(
  runCommand: LinuxToolCommandExecutor,
  whichCommand: LinuxToolAvailabilityChecker,
  display: LinuxDisplayConfig,
): LinuxScreenshotProvider {
  return {
    async capture(outPath) {
      const tool = await resolveLocalLinuxTool(whichCommand, display, LOCAL_SCREENSHOT_TOOLS);
      const command = LOCAL_SCREENSHOT_COMMANDS[tool](outPath);
      await runCommand(command.cmd, command.args, command.options);
    },
  };
}

type LocalLinuxClipboardTool = 'wl-clipboard' | 'xclip' | 'xsel';
type LocalLinuxScreenshotTool = 'grim' | 'gnome-screenshot' | 'scrot' | 'import';
type LocalLinuxToolCommand = {
  cmd: string;
  args: string[];
  options?: ExecOptions;
};
type LocalLinuxToolCandidate<T extends string> = {
  tool: T;
  command: string;
};
type LocalLinuxToolConfig<T extends string> = {
  wayland: readonly LocalLinuxToolCandidate<T>[];
  x11: readonly LocalLinuxToolCandidate<T>[];
  waylandError: string;
  x11Error: string;
};

const LOCAL_TOOL_TIMEOUT_MS = 5000;

const LOCAL_CLIPBOARD_TOOLS = {
  wayland: [{ tool: 'wl-clipboard', command: 'wl-paste' }],
  x11: [
    { tool: 'xclip', command: 'xclip' },
    { tool: 'xsel', command: 'xsel' },
  ],
  waylandError:
    'wl-paste (wl-clipboard) is required for clipboard access on Wayland. Install via your package manager.',
  x11Error:
    'xclip or xsel is required for clipboard access on X11. Install via your package manager.',
} satisfies LocalLinuxToolConfig<LocalLinuxClipboardTool>;

const LOCAL_SCREENSHOT_TOOLS = {
  wayland: [
    { tool: 'grim', command: 'grim' },
    { tool: 'gnome-screenshot', command: 'gnome-screenshot' },
  ],
  x11: [
    { tool: 'scrot', command: 'scrot' },
    { tool: 'import', command: 'import' },
    { tool: 'gnome-screenshot', command: 'gnome-screenshot' },
  ],
  waylandError:
    'grim or gnome-screenshot is required for screenshots on Wayland. Install via your package manager.',
  x11Error:
    'scrot, import (ImageMagick), or gnome-screenshot is required for screenshots on X11. Install via your package manager.',
} satisfies LocalLinuxToolConfig<LocalLinuxScreenshotTool>;

const LOCAL_CLIPBOARD_READ_COMMANDS: Record<LocalLinuxClipboardTool, LocalLinuxToolCommand> = {
  'wl-clipboard': {
    cmd: 'wl-paste',
    args: ['--no-newline'],
    options: { allowFailure: true, timeoutMs: LOCAL_TOOL_TIMEOUT_MS },
  },
  xclip: {
    cmd: 'xclip',
    args: ['-selection', 'clipboard', '-o'],
    options: { allowFailure: true, timeoutMs: LOCAL_TOOL_TIMEOUT_MS },
  },
  xsel: {
    cmd: 'xsel',
    args: ['--clipboard', '--output'],
    options: { allowFailure: true, timeoutMs: LOCAL_TOOL_TIMEOUT_MS },
  },
};

const LOCAL_CLIPBOARD_WRITE_COMMANDS: Record<
  LocalLinuxClipboardTool,
  (text: string) => LocalLinuxToolCommand
> = {
  'wl-clipboard': (text) => ({
    cmd: 'wl-copy',
    args: ['--', text],
    options: { allowFailure: false, timeoutMs: LOCAL_TOOL_TIMEOUT_MS },
  }),
  xclip: (text) => ({
    cmd: 'xclip',
    args: ['-selection', 'clipboard'],
    options: { allowFailure: false, timeoutMs: LOCAL_TOOL_TIMEOUT_MS, stdin: text },
  }),
  xsel: (text) => ({
    cmd: 'xsel',
    args: ['--clipboard', '--input'],
    options: { allowFailure: false, timeoutMs: LOCAL_TOOL_TIMEOUT_MS, stdin: text },
  }),
};

const LOCAL_SCREENSHOT_COMMANDS: Record<
  LocalLinuxScreenshotTool,
  (outPath: string) => LocalLinuxToolCommand
> = {
  grim: (outPath) => ({ cmd: 'grim', args: [outPath] }),
  scrot: (outPath) => ({ cmd: 'scrot', args: [outPath] }),
  import: (outPath) => ({ cmd: 'import', args: ['-window', 'root', outPath] }),
  'gnome-screenshot': (outPath) => ({ cmd: 'gnome-screenshot', args: ['-f', outPath] }),
};

async function resolveLocalLinuxTool<T extends string>(
  whichCommand: LinuxToolAvailabilityChecker,
  display: LinuxDisplayConfig,
  config: LocalLinuxToolConfig<T>,
): Promise<T> {
  const server = display.detectDisplayServer();
  for (const candidate of config[server]) {
    if (await whichCommand(candidate.command)) return candidate.tool;
  }
  throw new AppError('TOOL_MISSING', server === 'wayland' ? config.waylandError : config.x11Error);
}
