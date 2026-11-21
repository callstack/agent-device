import { createLinuxCommandRunner, type LinuxCommandRunner } from './command-runner.ts';
import type { PlatformHost } from 'agent-device/plugins';

/**
 * Everything the Linux family needs from the machine it runs on, built once from the `PlatformHost`
 * the core hands `setup()`, and shared by inventory, the runtime, the interactor and the capture.
 *
 * It exists so the plugin never reaches for process globals of its own. The package is bundled with
 * its own copy of the host kit, and the daemon's command scope never enters that copy, so a spawn
 * made through it would run with the daemon's environment and outside the request's exec trace.
 * Going through the host keeps resolution, environment and diagnostics where the core put them.
 */
export type LinuxToolbox = Readonly<{
  /** Host commands, availability probes, detached launches and family diagnostics. */
  commands: LinuxCommandRunner;
  /** The host environment the plugin was set up with: the display decision reads it (#3794). */
  env: PlatformHost['env'];
  /** Timings for this family's operations, in the request's diagnostic store. */
  withDiagnosticTimer: PlatformHost['withDiagnosticTimer'];
}>;

export function createLinuxToolbox(host: PlatformHost): LinuxToolbox {
  return Object.freeze({
    commands: createLinuxCommandRunner(host),
    env: host.env,
    withDiagnosticTimer: host.withDiagnosticTimer,
  });
}
