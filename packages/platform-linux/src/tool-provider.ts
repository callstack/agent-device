import { AppError } from '@agent-device/kernel/errors';
import { createScopedProvider } from '@agent-device/kernel/scoped-provider';
import type {
  LinuxClipboardProvider,
  LinuxDesktopProvider,
  LinuxScreenshotProvider,
  LinuxToolProvider,
} from '@agent-device/contracts/linux-tool-provider';
import { createLinuxAccessibilityProvider } from './atspi-bridge.ts';
import type { LinuxToolbox } from './toolbox.ts';
import { createLinuxDisplayConfig } from './display.ts';

export type { LinuxToolProvider } from '@agent-device/contracts/linux-tool-provider';

/** The parts a caller may supply over the family's own tool route, each answering one intent. */
export type LinuxToolProviderOverrides = Partial<Omit<LinuxToolProvider, 'display'>>;

/**
 * Builds the local provider for one host: every Linux tool call it makes runs through the toolbox the
 * plugin was set up with, and the display decision comes from that host's environment, never an
 * ambient read (#3794).
 */
export function createLinuxToolProvider(
  toolbox: LinuxToolbox,
  overrides: LinuxToolProviderOverrides = {},
): LinuxToolProvider {
  // The command primitives are resolved first, and the family's own semantic parts are built on the
  // resolved ones: a caller that replaces the command route or the pacing replaces it for the whole
  // provider, not only for the methods it named. The display decision is never replaced: it is read
  // from the host this toolbox was set up with, which is what makes it the same decision the tools
  // this provider spawns were resolved for (#3794).
  const commands = withCommandOverrides(toolbox.commands, overrides);
  const display = createLinuxDisplayConfig(() => toolbox.env);
  return Object.freeze({
    display,
    runCommand: commands.run,
    whichCommand: commands.which,
    launchDetached: commands.launchDetached,
    sleep: commands.sleep,
    desktop: overrides.desktop ?? createLinuxDesktopProvider(commands),
    clipboard: overrides.clipboard ?? createLinuxClipboardProvider(commands, display),
    screenshot: overrides.screenshot ?? createLinuxScreenshotProvider(commands, display),
    accessibility: overrides.accessibility ?? createLinuxAccessibilityProvider(commands),
    ...(overrides.input ? { input: overrides.input } : {}),
  });
}

function withCommandOverrides(
  commands: LinuxToolbox['commands'],
  overrides: LinuxToolProviderOverrides,
): LinuxToolbox['commands'] {
  return Object.freeze({
    run: overrides.runCommand ?? commands.run,
    which: overrides.whichCommand ?? commands.which,
    launchDetached: overrides.launchDetached ?? commands.launchDetached,
    sleep: overrides.sleep ?? commands.sleep,
    diagnose: commands.diagnose,
  });
}

/**
 * The request scope the Linux family owns. Root composition resolves a provider for a request and
 * hands it back to the plugin through the registration's `withRequestProvider`, which enters it for
 * the request's work. The interactor and the runtime read the entered provider in preference to the
 * one built from their own host, so a request that owns a display decision and a command route is the
 * only one that answers for it.
 */
const linuxToolProviderScope = createScopedProvider<
  LinuxToolProvider | undefined,
  LinuxToolProvider
>(undefined);

/** The provider this call should use: the one a request scoped, else the caller's own. */
export function resolveLinuxToolProvider(own: LinuxToolProvider): LinuxToolProvider {
  return linuxToolProviderScope.resolve() ?? own;
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

export function createLinuxDesktopProvider(
  commands: LinuxToolbox['commands'],
): LinuxDesktopProvider {
  return {
    async openTarget(target) {
      if (target.includes('://') || target.startsWith('/')) {
        await commands.run('xdg-open', [target]);
        return;
      }

      if (await commands.which(target)) {
        // A desktop app outlives the command that opened it. Run detached with its output discarded:
        // a piped child would keep everything it prints in daemon memory until it exits.
        void commands.launchDetached(target, []).exited.then((exit) => {
          const failure = describeLaunchExit(exit);
          if (failure === undefined) return;
          commands.diagnose({
            level: 'warn',
            phase: 'linux_app_launch',
            data: { app: target, ...failure },
          });
        });
        await commands.sleep(500);
        return;
      }

      await commands.run('xdg-open', [target], { allowFailure: true });
    },
    async closeApp(app) {
      if (await commands.which('wmctrl')) {
        await commands.run('wmctrl', ['-c', app], { allowFailure: true });
        return;
      }

      await commands.run('pkill', ['-x', app], { allowFailure: true });
    },
  };
}

export function createLinuxClipboardProvider(
  commands: LinuxToolbox['commands'],
  display: LinuxToolProvider['display'],
): LinuxClipboardProvider {
  return {
    async readText() {
      const tool = await resolveLocalLinuxTool(commands, display, LOCAL_CLIPBOARD_TOOLS);
      const command = LOCAL_CLIPBOARD_READ_COMMANDS[tool];
      return (await commands.run(command.cmd, command.args, command.options)).stdout;
    },
    async writeText(text) {
      const tool = await resolveLocalLinuxTool(commands, display, LOCAL_CLIPBOARD_TOOLS);
      const command = LOCAL_CLIPBOARD_WRITE_COMMANDS[tool](text);
      await commands.run(command.cmd, command.args, command.options);
    },
  };
}

export function createLinuxScreenshotProvider(
  commands: LinuxToolbox['commands'],
  display: LinuxToolProvider['display'],
): LinuxScreenshotProvider {
  return {
    async capture(outPath) {
      const tool = await resolveLocalLinuxTool(commands, display, LOCAL_SCREENSHOT_TOOLS);
      const command = LOCAL_SCREENSHOT_COMMANDS[tool](outPath);
      await commands.run(command.cmd, command.args, command.options);
    },
  };
}

/** What a launched app's exit says went wrong: a start failure, a non-zero exit, or a signal. */
function describeLaunchExit(
  exit: Awaited<ReturnType<LinuxToolbox['commands']['launchDetached']>['exited']>,
): Record<string, unknown> | undefined {
  if (exit.error !== undefined) return { error: exit.error };
  if (exit.signal !== undefined) return { signal: exit.signal };
  if (exit.exitCode !== undefined && exit.exitCode !== 0) return { exitCode: exit.exitCode };
  return undefined;
}

type LocalLinuxClipboardTool = 'wl-clipboard' | 'xclip' | 'xsel';
type LocalLinuxScreenshotTool = 'grim' | 'gnome-screenshot' | 'scrot' | 'import';
type LocalLinuxToolCommand = {
  cmd: string;
  args: string[];
  options?: { allowFailure?: boolean; timeoutMs?: number; stdin?: string };
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
  commands: LinuxToolbox['commands'],
  display: LinuxToolProvider['display'],
  config: LocalLinuxToolConfig<T>,
): Promise<T> {
  const server = display.detectDisplayServer();
  for (const candidate of config[server]) {
    if (await commands.which(candidate.command)) return candidate.tool;
  }
  throw new AppError('TOOL_MISSING', server === 'wayland' ? config.waylandError : config.x11Error);
}
