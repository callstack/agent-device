/**
 * Shared Linux input-tool resolution — display server and input tool.
 *
 * The display decision comes from the resolved provider's bound host, never an ambient read
 * (#3794). Nothing is memoized: the interactor that enters a provider is built per request, so a
 * cache would not outlive the request it serves. A refusal simply throws.
 */

import { AppError } from '@agent-device/kernel/errors';
import { resolveLinuxToolProvider, type LinuxToolProvider } from './tool-provider.ts';
import type { DisplayServer } from './display.ts';
import type { LinuxInputSelection } from './input-tool.ts';

export async function ensureInputTool(
  provider: LinuxToolProvider = resolveLinuxToolProvider(),
): Promise<LinuxInputSelection> {
  const display: DisplayServer = provider.display.detectDisplayServer();

  if (display === 'wayland') {
    if (await provider.whichCommand('ydotool')) return { tool: 'ydotool', display };
    throw new AppError(
      'TOOL_MISSING',
      'ydotool is required for input synthesis on Wayland (xdotool does not work on Wayland). Install it via your package manager.',
    );
  }

  if (await provider.whichCommand('xdotool')) return { tool: 'xdotool', display };
  throw new AppError(
    'TOOL_MISSING',
    'xdotool is required for input synthesis on X11. Install it via your package manager.',
  );
}
