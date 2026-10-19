import { projectCoverage } from '../command-coverage/declarations.ts';
import type { PublicCommand } from '../command-coverage/entries.ts';
import { LINUX_COMMAND_EVIDENCE, LINUX_REPLAY_EVIDENCE } from '../command-coverage/evidence.ts';
import { buildCoverageClassificationSummary } from '../support/coverage-classification.ts';

export { LINUX_COMMAND_EVIDENCE, LINUX_REPLAY_EVIDENCE } from '../command-coverage/evidence.ts';

/**
 * One primary, observable owner for every public command on the Linux desktop.
 *
 * Live rows cite either the existing Linux replay or the separate command-evidence
 * lane. The existing replay scope stays unchanged. Contract rows cite the existing
 * provider scenario or dedicated Linux runtime-fact evidence; they do not turn
 * mocked provider calls into live desktop claims. Capability denials are derived
 * from the owning command-descriptor matrix. Every remaining gap is an accepted
 * limitation naming why no lane will cover it; Linux carries no open tracking issue.
 *
 * Projected from the command-owned declaration table; the rows are authored there.
 */
export const LINUX_PLATFORM_COVERAGE = projectCoverage('linux');

export const LINUX_PLATFORM_COVERAGE_CLASSIFICATION_SUMMARY = buildCoverageClassificationSummary(
  Object.values(LINUX_PLATFORM_COVERAGE),
);

export function liveCommandsForLinuxReplay(): PublicCommand[] {
  return Object.entries(LINUX_PLATFORM_COVERAGE)
    .filter(
      ([, entry]) => entry.level === 'live' && entry.owner.path === LINUX_REPLAY_EVIDENCE.path,
    )
    .map(([command]) => command as PublicCommand);
}

export function liveCommandsForLinuxCommandEvidence(): PublicCommand[] {
  return Object.entries(LINUX_PLATFORM_COVERAGE)
    .filter(
      ([, entry]) => entry.level === 'live' && entry.owner.path === LINUX_COMMAND_EVIDENCE.path,
    )
    .map(([command]) => command as PublicCommand);
}
