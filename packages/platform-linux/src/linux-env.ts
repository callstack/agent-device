/**
 * Shared Linux input-tool resolution — display server and input tool.
 *
 * The display decision comes from the provider that is running the action, never an ambient read
 * (#3794). Nothing is memoized: a refusal simply throws, and the next call asks again, which is what
 * lets a tool installed while the daemon runs answer without a restart.
 */

import { AppError } from '@agent-device/kernel/errors';
import type {
  LinuxInputSelection,
  LinuxToolProvider,
} from '@agent-device/contracts/linux-tool-provider';

export async function ensureInputTool(
  provider: LinuxToolProvider,
): Promise<LinuxInputSelection> {
  const display = provider.display.detectDisplayServer();

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
