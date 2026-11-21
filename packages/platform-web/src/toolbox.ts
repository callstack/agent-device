import type { PlatformHost } from 'agent-device/plugins';
import { createWebCommandRunner, type WebCommandRunner } from './command-host.ts';

/**
 * Everything the web family needs from the machine it runs on, built once from the `PlatformHost` the
 * core hands `setup()`, and shared by the backend tool, the provider, the fleet record, the
 * interactor and doctor.
 *
 * It exists so the plugin never reaches for process globals of its own. The package is bundled with
 * its own copy of the host kit, and the daemon's command scope never enters that copy, so a spawn
 * made through it would run with the daemon's environment and outside the request's exec trace.
 * Going through the host keeps spawning, executable probes, process reads and diagnostics where the
 * core put them.
 */
export type WebToolbox = Readonly<{
  /** The host this plugin was set up with: environment, state dir, diagnostics, process resources. */
  host: PlatformHost;
  /** Host commands, run with the environment the caller builds for the managed backend. */
  commands: WebCommandRunner;
  /** Timings and traces for this family's operations, in the request's diagnostic store. */
  withDiagnosticTimer: PlatformHost['withDiagnosticTimer'];
}>;

export function createWebToolbox(host: PlatformHost): WebToolbox {
  return Object.freeze({
    host,
    commands: createWebCommandRunner(host),
    withDiagnosticTimer: host.withDiagnosticTimer,
  });
}
