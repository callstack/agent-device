import { projectCoverage } from '../command-coverage/declarations.ts';
import type { PublicCommand } from '../command-coverage/entries.ts';
import { buildCoverageClassificationSummary } from '../support/coverage-classification.ts';

export {
  WEB_COVERAGE_GAP_ISSUE,
  WEB_SMOKE_EVIDENCE,
  WEB_SMOKE_TEST_NAME,
} from '../command-coverage/evidence.ts';

/**
 * One primary, observable owner for every public command on the managed web target.
 *
 * Live rows are limited to the existing web-smoke scenario; they do not widen its scope. Contract
 * rows do not
 * turn fixture-backed tests into live E2E claims, and cite one of two evidence shapes: a
 * web-specific unit/provider test exercising the command's own operation (e.g. `click`, `hover`);
 * or, for a command whose handler has no platform branch at all, a test proving its existing
 * generic/shared code path runs correctly for a web-backed session or device (e.g. `artifacts`,
 * `batch`, `diff`, `press`), OR the web runtime's own unavailable-operation fact, a real and
 * permanent denial (e.g. `boot`, `push`).
 *
 * #1900 closed 14 of the 15 known-gap rows this manifest originally carried using the shapes
 * above. `test` stays `known-gap`: its declared-platform filter structurally excludes web
 * (`ReplayTestPlatform = Exclude<PlatformSelector, 'web'>`), so `test --platform web` can never
 * select a script — real, tested, command-specific behavior (see
 * `session-command-replay.test.ts`), but evidence of what the command cannot do, not executable
 * evidence that it works on web. Closing this row needs a separate product decision: either web
 * replay-test support, or an explicit denial.
 *
 * Projected from the command-owned declaration table; the rows are authored there.
 */
export const WEB_PLATFORM_COVERAGE = projectCoverage('web');

export const WEB_PLATFORM_COVERAGE_CLASSIFICATION_SUMMARY = buildCoverageClassificationSummary(
  Object.values(WEB_PLATFORM_COVERAGE),
);

export function liveCommandsForWebSmoke(): PublicCommand[] {
  return Object.entries(WEB_PLATFORM_COVERAGE)
    .filter(([, entry]) => entry.level === 'live')
    .map(([command]) => command as PublicCommand);
}
