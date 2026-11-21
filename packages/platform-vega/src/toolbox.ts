import type { PlatformHost } from 'agent-device/plugins';
import { createVegaCommandRunner, type VegaCommandRunner } from './command-host.ts';

/**
 * Everything the Vega family needs from the machine it runs on, built once from the `PlatformHost`
 * the core hands `setup()`, and shared by inventory, the runtime, the interactor and doctor.
 *
 * It exists so the plugin never reaches for process globals of its own. The package is bundled with
 * its own copy of the host kit, and the request's command scope never enters that copy, so a spawn
 * made through it would run with the daemon's environment and outside the request's exec trace.
 * Going through the host keeps CLI resolution, environment and diagnostics where the core put them.
 */
export type VegaToolbox = Readonly<{
  /** The Vega CLI route: one resolver over the host, one spawn per call. */
  commands: VegaCommandRunner;
}>;

export function createVegaToolbox(host: PlatformHost): VegaToolbox {
  return Object.freeze({
    commands: createVegaCommandRunner(host),
  });
}
