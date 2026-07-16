/**
 * Shared Linux environment detection — display server and input tool.
 *
 * Results are cached after the first probe so that every action
 * (press, type, scroll…) does not re-run `which` on every call.
 */

import { AppError } from '../../kernel/errors.ts';
import { resolveLinuxToolProvider, type LinuxToolProvider } from './tool-provider.ts';

export type DisplayServer = 'wayland' | 'x11';
export type InputTool = 'xdotool' | 'ydotool';

function detectDisplayServer(): DisplayServer {
  if (process.env['WAYLAND_DISPLAY']) return 'wayland';
  if (process.env['XDG_SESSION_TYPE'] === 'wayland') return 'wayland';
  return 'x11';
}

// ── Cached input tool resolution ───────────────────────────────────────

let cachedInputTool: {
  tool: InputTool;
  display: DisplayServer;
  provider: LinuxToolProvider;
} | null = null;

export async function ensureInputTool(): Promise<{
  tool: InputTool;
  display: DisplayServer;
}> {
  const provider = resolveLinuxToolProvider();
  if (cachedInputTool?.provider === provider) return cachedInputTool;

  const display = detectDisplayServer();

  if (display === 'wayland') {
    if (await provider.whichCommand('ydotool')) {
      cachedInputTool = { tool: 'ydotool', display, provider };
      return cachedInputTool;
    }
    throw new AppError(
      'TOOL_MISSING',
      'ydotool is required for input synthesis on Wayland (xdotool does not work on Wayland). Install it via your package manager.',
    );
  }

  if (await provider.whichCommand('xdotool')) {
    cachedInputTool = { tool: 'xdotool', display, provider };
    return cachedInputTool;
  }
  throw new AppError(
    'TOOL_MISSING',
    'xdotool is required for input synthesis on X11. Install it via your package manager.',
  );
}

/**
 * @internal Test isolation hook for the cached Linux input tool.
 */
export function resetInputToolCache(): void {
  cachedInputTool = null;
}
