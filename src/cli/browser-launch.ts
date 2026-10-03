/**
 * Hands a URL to the host's default browser without a shell. The auth flow reaches this module at
 * the call site, not at import time: opening a browser belongs to one interactive path, and the CLI
 * entry's eager module closure is budgeted (ADR 0019).
 */

import { runCmd } from '@agent-device/host-kit/command';

const BROWSER_LAUNCH_TIMEOUT_MS = 5000;
const WINDOWS_FILE_PROTOCOL_HANDLER = 'url.dll,FileProtocolHandler';
const NON_PRINTABLE_CHARACTERS = /[\p{Cc}\p{Cf}]/u;

type BrowserLauncher = {
  command: string;
  args: string[];
  /** The Windows launcher hands the URL to the shell, whose own refusal is not reported back
   * through the exit status, so a spawned Windows launcher counts as launched. */
  ignoresExitStatus: boolean;
};

/**
 * Whether a server-provided URL may be launched in a browser and printed to a terminal: an
 * `http`/`https` URL with no control characters, which a terminal would act on, and no format
 * characters, whose bidi overrides and zero-width characters spoof how a URL reads.
 */
export function isSafeBrowserUrl(value: string): boolean {
  if (NON_PRINTABLE_CHARACTERS.test(value)) return false;
  try {
    const { protocol } = new URL(value);
    return protocol === 'http:' || protocol === 'https:';
  } catch {
    return false;
  }
}

/** The URL is always one inert argv entry. Windows `cmd /c start` re-tokenizes its argument string
 * even when it is spawned as argv, so a URL carrying `&`, `^`, or `|` would run an extra command. */
function resolveBrowserLauncher(platform: NodeJS.Platform, url: string): BrowserLauncher {
  if (platform === 'darwin') {
    return { command: 'open', args: [url], ignoresExitStatus: false };
  }
  if (platform === 'win32') {
    return {
      command: 'rundll32.exe',
      args: [WINDOWS_FILE_PROTOCOL_HANDLER, url],
      ignoresExitStatus: true,
    };
  }
  return { command: 'xdg-open', args: [url], ignoresExitStatus: false };
}

/**
 * Hand a URL to the default browser, refusing one that `isSafeBrowserUrl` would reject. Returns
 * false when nothing was launched, so the caller can still point the user at the URL.
 */
export async function openUrlInBrowser(url: string): Promise<boolean> {
  if (!isSafeBrowserUrl(url)) return false;
  const launcher = resolveBrowserLauncher(process.platform, url);
  try {
    const { exitCode } = await runCmd(launcher.command, launcher.args, {
      allowFailure: true,
      timeoutMs: BROWSER_LAUNCH_TIMEOUT_MS,
    });
    return launcher.ignoresExitStatus || exitCode === 0;
  } catch {
    return false;
  }
}
