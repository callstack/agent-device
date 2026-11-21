import type { LinuxDisplayServer } from '@agent-device/contracts/linux-tool-provider';

/** The display decision bound to one host environment. */
export type LinuxDisplayConfig = Readonly<{
  detectDisplayServer(): LinuxDisplayServer;
}>;

/**
 * Reads the display server from one host's environment: the only display decision in the family.
 * A Wayland session is announced by its socket or by the session type, and anything else drives X11.
 */
function detectLinuxDisplayServer(
  env: Readonly<Record<string, string | undefined>>,
): LinuxDisplayServer {
  if (env['WAYLAND_DISPLAY']) return 'wayland';
  if (env['XDG_SESSION_TYPE'] === 'wayland') return 'wayland';
  return 'x11';
}

/**
 * The display decision of the host the plugin was set up with, read from the environment that
 * `readEnv` returns on each question. The family passes the setup host's environment, so the answer
 * follows that environment, not the daemon's own.
 */
export function createLinuxDisplayConfig(
  readEnv: () => Readonly<Record<string, string | undefined>>,
): LinuxDisplayConfig {
  return Object.freeze({
    detectDisplayServer: () => detectLinuxDisplayServer(readEnv()),
  });
}
