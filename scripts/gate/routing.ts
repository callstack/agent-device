// Routed lanes: a `paths-ignore` list held to the affected selector, both ways (#1781 A9-2).
//
// GitHub evaluates `paths-ignore` before it allocates a runner, so it is the one routing
// mechanism that costs no macOS time and adds no job to the critical path. Its weakness is
// that it is a hand-written glob list next to a derived selector — the two drift the first
// time someone adds a platform root or a unit-test convention. This assertion is what makes
// the YAML a derived artifact: over every tracked path, the lane must start whenever the
// selector says the change can reach it, and must not start on a path the selector places on
// another family's device-lane surface or classifies as a unit test.

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
// `.github/**` is about *local* checks and cannot see that. A glob there is not exempt: it
// could hide the composite action the lane itself runs.
function ignoredByExactName(lane: Lane, file: string): boolean {
  return file.startsWith('.github/') && lane.pathsIgnore.includes(file);
}

export function routingFor(model: Model, routed: RoutedLane): RoutingFailure[] {
  const lane = model.lanes.find((candidate) => candidate.label === routed.lane);
  if (!lane) {
    return [failure(`routed lane "${routed.lane}" is not defined by any workflow.`)];
  }
  if (!lane.triggers.includes('pull_request')) {
    return [failure(`routed lane "${routed.lane}" has no pull_request trigger to route.`)];
  }
  const needs = new Set<string>([...lane.gates, ...routed.sampled]);
  const failures: RoutingFailure[] = [];
  for (const file of [...model.trackedFiles].sort()) {
    if (isDocs(file)) continue;
    const plan = selectChecks({ changedFiles: [file], packageEntryFiles: model.packageEntryFiles });
    const routedTo = plan.checks.filter((id) => needs.has(id));
    const needsLane = plan.failOpen || routedTo.length > 0;
    const starts = triggersOnPath(lane, file);
    if (needsLane && !starts && !ignoredByExactName(lane, file)) {
      const why = plan.failOpen
        ? `fails open on it (${plan.failOpenReasons.map((reason) => reason.rule).join(', ')})`
        : `routes it to ${routedTo.map((id) => `"${id}"`).join(', ')}`;
      failures.push(
        failure(
          `${lane.workflow} ignores ${file}, but the selector ${why}. Remove the ignore entry.`,
        ),
      );
      continue;
    }
    if (needsLane || !starts) continue;
    const surface = isDeviceLaneSurface(file) ? deviceLanesFor(file) : null;
    const claim = isUnitTest(file)
      ? 'a unit test no device lane runs'
      : surface && !surface.lanes.some((id: CheckId) => needs.has(id))
        ? `${surface.leaf}-owned (lanes: ${surface.lanes.join(', ') || 'none'})`
        : null;
    if (claim === null) continue;
    failures.push(
      failure(
        `${lane.workflow} starts on ${file}, which the selector classifies as ${claim}. ` +
          `Add it to paths-ignore, or the routing claim is false for that path.`,
      ),
    );
  }
  return failures;
}

export function routing(model: Model, routedLanes: readonly RoutedLane[]): RoutingFailure[] {
  return routedLanes.flatMap((routed) => routingFor(model, routed));
}
