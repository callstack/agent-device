import { PUBLIC_COMMANDS } from '@agent-device/command-registry/catalog';
import { projectCoverage } from '../command-coverage/declarations.ts';
import type { PublicCommand } from '../command-coverage/entries.ts';
import { buildCoverageClassificationSummary } from '../support/coverage-classification.ts';

export {
  TVOS_COVERAGE_GAP_ISSUE,
  TVOS_REMOTE_EVIDENCE,
  TVOS_REMOTE_TEST_NAME,
} from '../command-coverage/evidence.ts';

export const TVOS_REMOTE_SCENARIO_COMMANDS: readonly PublicCommand[] = [
  PUBLIC_COMMANDS.open,
  PUBLIC_COMMANDS.scroll,
  PUBLIC_COMMANDS.back,
  PUBLIC_COMMANDS.home,
  PUBLIC_COMMANDS.close,
];

/**
 * One primary, observable owner for every public command on the tvOS leaf.
 *
 * There is no tvOS CI or live-device lane at HEAD, so the existing provider
 * scenario is contract evidence rather than a live claim. The remaining
 * contract rows cite Apple deployment/inventory tests, the typed Apple
 * interaction policy, or the executable capability oracle. Capability denials
 * are limited to whole-command denials; tvOS's narrower multi-touch refusal
 * stays with the gesture contract instead of denying the supported one-contact
 * gesture path. Host-dependent contracts retain their oracle admission state
 * without claiming a stable tvOS capability.
 *
 * Projected from the command-owned declaration table; the rows are authored there.
 */
export const TVOS_PLATFORM_COVERAGE = projectCoverage('tvos');

export const TVOS_PLATFORM_COVERAGE_CLASSIFICATION_SUMMARY = buildCoverageClassificationSummary(
  Object.values(TVOS_PLATFORM_COVERAGE),
);
