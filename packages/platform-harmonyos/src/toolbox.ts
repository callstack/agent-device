import type { PlatformHost } from 'agent-device/plugins';
import { createHarmonyCommandRunner, type HarmonyCommandRunner } from './command-host.ts';
import { createHarmonyHdcRunner, type HarmonyHdcRunner } from './hdc.ts';

/**
 * Everything the HarmonyOS family needs from the machine it runs on, built once from the
 * `PlatformHost` the core hands `setup()`, and shared by inventory, the runtime, the interactor and
 * the recorder.
 *
 * It exists so the plugin never reaches for process globals of its own. The package is bundled with
 * its own copy of the host kit, and the daemon's command scope never enters that copy, so a spawn
 * made through it would run with the daemon's environment and outside the request's exec trace.
 * Going through the host keeps resolution, cwd, environment and diagnostics where the core put them.
 */
export type HarmonyToolbox = Readonly<{
  /** Host commands, run with the documented HarmonyOS toolchain roots already on `PATH`. */
  commands: HarmonyCommandRunner;
  /** The HDC route: one launcher, scoped to one target per call. */
  hdc: HarmonyHdcRunner;
  /** Timings and traces for this family's operations, in the request's diagnostic store. */
  withDiagnosticTimer: PlatformHost['withDiagnosticTimer'];
}>;

export function createHarmonyToolbox(host: PlatformHost): HarmonyToolbox {
  const commands = createHarmonyCommandRunner(host);
  return Object.freeze({
    commands,
    hdc: createHarmonyHdcRunner(commands),
    withDiagnosticTimer: host.withDiagnosticTimer,
  });
}
