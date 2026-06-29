import { runCmd, whichCmd, type ExecOptions, type ExecResult } from '../../utils/exec.ts';
import { emitDiagnostic } from '../../utils/diagnostics.ts';
import { AppError } from '../../kernel/errors.ts';
import { createScopedProvider } from '../../utils/scoped-provider.ts';
import { sleep } from '../../utils/timeouts.ts';
import type { ClickButton } from '../../core/click-button.ts';
import type {
  LinuxAccessibilityTree,
  LinuxSnapshotSurface,
  LinuxTraversalOptions,
} from './accessibility-types.ts';
import type { ScrollDirection } from '../../core/scroll-gesture.ts';

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
  runCommand: LinuxToolCommandExecutor;
  whichCommand: LinuxToolAvailabilityChecker;
  desktop: LinuxDesktopProvider;
  clipboard?: LinuxClipboardProvider;
  screenshot?: LinuxScreenshotProvider;
  accessibility?: LinuxAccessibilityProvider;
  input?: LinuxInputProvider;
};

const localLinuxToolProvider: LinuxToolProvider = {
  runCommand: runCmd,
  whichCommand: whichCmd,
  desktop: createLocalLinuxDesktopProvider(runCmd, whichCmd),
  clipboard: createLocalLinuxClipboardProvider(runCmd, whichCmd),
  screenshot: createLocalLinuxScreenshotProvider(runCmd, whichCmd),
};

const linuxToolProviderScope = createScopedProvider(
  localLinuxToolProvider,
  createLocalLinuxToolProvider,
);

export function createLocalLinuxToolProvider(
  provider: Partial<LinuxToolProvider> = {},
): LinuxToolProvider {
  const merged = {
    ...localLinuxToolProvider,
    ...provider,
  };
  return {
    ...merged,
    desktop:
      provider.desktop ?? createLocalLinuxDesktopProvider(merged.runCommand, merged.whichCommand),
    clipboard:
      provider.clipboard ??
      createLocalLinuxClipboardProvider(merged.runCommand, merged.whichCommand),
    screenshot:
      provider.screenshot ??
      createLocalLinuxScreenshotProvider(merged.runCommand, merged.whichCommand),
  };
}

export function resolveLinuxToolProvider(provider?: LinuxToolProvider): LinuxToolProvider {
  return linuxToolProviderScope.resolve(provider);
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
        runCommand(target, [], { allowFailure: true }).catch((err) => {
          emitDiagnostic({
            level: 'warn',
            phase: 'linux_app_launch',
            data: { app: target, error: String(err) },
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
): LinuxClipboardProvider {
  return {
    async readText() {
      const tool = await resolveLocalLinuxTool(whichCommand, LOCAL_CLIPBOARD_TOOLS);
      const command = LOCAL_CLIPBOARD_READ_COMMANDS[tool];
      return (await runCommand(command.cmd, command.args, command.options)).stdout;
    },
    async writeText(text) {
      const tool = await resolveLocalLinuxTool(whichCommand, LOCAL_CLIPBOARD_TOOLS);
      const command = LOCAL_CLIPBOARD_WRITE_COMMANDS[tool](text);
      await runCommand(command.cmd, command.args, command.options);
    },
  };
}

function createLocalLinuxScreenshotProvider(
  runCommand: LinuxToolCommandExecutor,
  whichCommand: LinuxToolAvailabilityChecker,
): LinuxScreenshotProvider {
  return {
    async capture(outPath) {
      const tool = await resolveLocalLinuxTool(whichCommand, LOCAL_SCREENSHOT_TOOLS);
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
  config: LocalLinuxToolConfig<T>,
): Promise<T> {
  const display = isLinuxWayland() ? 'wayland' : 'x11';
  for (const candidate of config[display]) {
    if (await whichCommand(candidate.command)) return candidate.tool;
  }
  throw new AppError('TOOL_MISSING', display === 'wayland' ? config.waylandError : config.x11Error);
}

function isLinuxWayland(): boolean {
  return Boolean(process.env['WAYLAND_DISPLAY']) || process.env['XDG_SESSION_TYPE'] === 'wayland';
}
