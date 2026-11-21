import type { LinuxDisplayServer } from '@agent-device/contracts/linux-tool-provider';

/** The display decision bound to one host environment. */
export type LinuxDisplayConfig = Readonly<{
  detectDisplayServer(): LinuxDisplayServer;
}>;

/**
 * Reads the display server from one host's environment: the only display decision in the family.
 * A Wayland session is announced by its socket or by the session type, and anything else drives X11.
 */
export function detectLinuxDisplayServer(
  env: Readonly<Record<string, string | undefined>>,
): LinuxDisplayServer {
  if (env['WAYLAND_DISPLAY']) return 'wayland';
  if (env['XDG_SESSION_TYPE'] === 'wayland') return 'wayland';
  return 'x11';
}

/**
 * The display decision of the host the plugin was set up with. The environment is read on each
 * question rather than once here, so a session that starts a Wayland compositor mid-request is not
 * pinned to the answer `setup` happened to see.
 */
export function createLinuxDisplayConfig(
  readEnv: () => Readonly<Record<string, string | undefined>>,
): LinuxDisplayConfig {
  return Object.freeze({
    detectDisplayServer: () => detectLinuxDisplayServer(readEnv()),
  });
}
