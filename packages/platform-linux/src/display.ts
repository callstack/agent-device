import type { EnvMap, HostEnvironment } from '@agent-device/kernel/source-value';

/** The Linux family's display-server vocabulary, from one detector (#3794). */
export type DisplayServer = 'wayland' | 'x11';

/**
 * The display decision bound to one host. A local provider builds it at construction from its
 * runtime's host, so input, clipboard and screenshot selection share one answer that no other
 * runtime's host can change (#3794).
 */
export type LinuxDisplayConfig = {
  detectDisplayServer(): DisplayServer;
};

/** Reads the display server from one host's environment; the only display decision in the family. */
export function detectLinuxDisplayServer(env: Readonly<EnvMap>): DisplayServer {
  if (env['WAYLAND_DISPLAY']) return 'wayland';
  if (env['XDG_SESSION_TYPE'] === 'wayland') return 'wayland';
  return 'x11';
}

export function createLinuxDisplayConfig(host: HostEnvironment): LinuxDisplayConfig {
  return Object.freeze({
    detectDisplayServer: () => detectLinuxDisplayServer(host.env),
  });
}
