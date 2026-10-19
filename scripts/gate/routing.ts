// Routed lanes: a `paths-ignore` list held to the affected selector, both ways (#1781 A9-2).
//
// GitHub evaluates `paths-ignore` before it allocates a runner, so it is the one routing
// mechanism that costs no macOS time and adds no job to the critical path. Its weakness is
// that it is a hand-written glob list next to a derived selector — the two drift the first
// time someone adds a platform root or a unit-test convention. This assertion is what makes
// the YAML a derived artifact: over every tracked path, the lane must start whenever the
// selector says the change can reach it, and must not start on a path the selector places on
// another family's device-lane surface or classifies as a unit test.
//
// One limit is GitHub's, not this assertion's: path filters examine only the first 300 changed
// files, so a PR larger than that can skip a routed lane on the strength of its first 300 paths
// alone. The unfiltered `push` to main is the backstop.

import { deviceLanesFor, isDeviceLaneSurface, isUnitTest } from '../check-affected/device-lanes.ts';
import { isDocs, selectChecks, type CheckId } from '../check-affected/model.ts';
import type { RoutedLane } from './declarations.ts';
import type { Model } from './model.ts';
import { type Lane, triggersOnPath } from './workflows.ts';

export type RoutingFailure = { readonly assertion: 'routing'; readonly message: string };

function failure(message: string): RoutingFailure {
  return { assertion: 'routing', message };
}

// A `.github/**` path the lane ignores by its exact name is the workflow's own knowledge of a
// sibling workflow it does not use (deploy, docs preview); the selector's fail-open on
// `.github/**` is about *local* checks and cannot see that.
//
// The exemption stops at the lane's own machinery, and that is enforced rather than asserted in
// prose: `lane.uses` is the transitive closure of the composite actions the job's steps run,
// plus the workflow file itself, so naming `setup-apple-runner-build/action.yml` or
// `boot-ios-test-simulator/action.yml` exactly is refused the way a glob is. Reviewer planted
// both and the manifest stayed green before this check existed.
function exemptSiblingWorkflow(lane: Lane, file: string): boolean {
  return (
    file.startsWith('.github/') && lane.pathsIgnore.includes(file) && !lane.uses.includes(file)
  );
}

// Why the selector says the lane must start on `file`, and what to do about it, or null when
// the lane need not start. The remedy differs by cause: a path the selector *routes* to the
// lane, or fails open on because it is tooling, is one the ignore list must not name. A path it
// fails open on because it has no owner at all (`unknown-path`/`ambiguous-path` — a fixture
// under a family root, say) is a selector gap: deleting the ignore entry that happens to match
// it would un-route every sibling in that tree, which is the opposite of the fix.
const UNOWNED_RULES = new Set(['unknown-path', 'ambiguous-path']);

function mustStart(model: Model, needs: ReadonlySet<string>, file: string): string | null {
  const plan = selectChecks({ changedFiles: [file], packageEntryFiles: model.packageEntryFiles });
  if (plan.failOpen) {
    const rules = plan.failOpenReasons.map((reason) => reason.rule);
    const remedy = rules.every((rule) => UNOWNED_RULES.has(rule))
      ? 'Give it an owning check in scripts/check-affected/ — the ignore entry that matches it ' +
        'is load-bearing for the rest of that tree'
      : 'Remove the ignore entry';
    return `fails open on it (${rules.join(', ')}). ${remedy}.`;
  }
  const routedTo = plan.checks.filter((id) => needs.has(id));
  return routedTo.length > 0
    ? `routes it to ${routedTo.map((id) => `"${id}"`).join(', ')}. Remove the ignore entry.`
    : null;
}

// How the selector classifies a path the lane need not start, or null when it makes no claim
// (a path outside the device-lane surface is simply not the routing's business).
function mustNotStart(needs: ReadonlySet<string>, file: string): string | null {
  if (isUnitTest(file)) return 'a unit test no device lane runs';
  if (!isDeviceLaneSurface(file)) return null;
  const { leaf, lanes } = deviceLanesFor(file);
  if (lanes.some((id: CheckId) => needs.has(id))) return null;
  return `${leaf}-owned (lanes: ${lanes.join(', ') || 'none'})`;
}

function routingFor(model: Model, routed: RoutedLane): RoutingFailure[] {
  const lane = model.lanes.find((candidate) => candidate.label === routed.lane);
  if (!lane) {
    return [failure(`routed lane "${routed.lane}" is not defined by any workflow.`)];
  }
  if (!lane.triggers.includes('pull_request')) {
    return [failure(`routed lane "${routed.lane}" has no pull_request trigger to route.`)];
  }
  const needs = new Set<string>([...lane.gates, ...routed.sampled]);
  return [...model.trackedFiles]
    .sort()
    .filter((file) => !isDocs(file))
    .flatMap((file) => {
      const starts = triggersOnPath(lane, file);
      const why = mustStart(model, needs, file);
      if (why !== null) {
        return starts || exemptSiblingWorkflow(lane, file)
          ? []
          : [failure(`${lane.workflow} ignores ${file}, but the selector ${why}`)];
      }
      const claim = starts ? mustNotStart(needs, file) : null;
      return claim === null
        ? []
        : [
            failure(
              `${lane.workflow} starts on ${file}, which the selector classifies as ${claim}. ` +
                `Add it to paths-ignore, or the routing claim is false for that path.`,
            ),
          ];
    });
}

export function routing(model: Model, routedLanes: readonly RoutedLane[]): RoutingFailure[] {
  return routedLanes.flatMap((routed) => routingFor(model, routed));
}
