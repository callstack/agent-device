import { projectCoverage } from '../command-coverage/declarations.ts';
import type { PublicCommand } from '../command-coverage/entries.ts';

/**
 * One primary owner for every public command on an iOS mobile simulator.
 *
 * "live" means a real simulator scenario does more than check exit status: it
 * asserts app/device state, typed data, or an artifact. Command-contract rows
 * are deliberately not presented as E2E coverage; they point to a named test
 * for functionality whose host permissions or source transport makes it a poor
 * fit for the shared hosted-simulator lane. This is catalog-complete command
 * ownership, not a claim that every optional backend or subcommand runs
 * nightly; cross-command mobile journeys are tracked separately in
 * behavior-coverage.ts.
 *
 * Projected from the command-owned declaration table; the rows are authored there.
 */
export const IOS_SIMULATOR_E2E_COVERAGE = projectCoverage('iosSimulator');

export function liveCommandsForScenario(scenarioId: string): PublicCommand[] {
  return Object.entries(IOS_SIMULATOR_E2E_COVERAGE)
    .filter(([, entry]) => entry.level === 'live' && entry.owner === scenarioId)
    .map(([command]) => command as PublicCommand);
}
