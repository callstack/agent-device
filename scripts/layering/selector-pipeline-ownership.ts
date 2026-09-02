import type { LayeringViolation, ResolvedImportEdge } from './model.ts';

/**
 * Catches: a route to the matching engine that bypasses selector-pipeline-policy.ts's declared
 *   structural stages (occlusion, off-screen, hittable-ancestor promotion, poll budget) — the
 *   route still gets an ambiguity contract, so it looks correct in review while silently
 *   skipping every stage the declared owner exists to guarantee.
 * Evidence: 74eab2a554 (#1744) routed selector-resolution structural stages into this typed
 *   policy, the migration this ownership check protects against regressing.
 * Cost: 154 LOC (66 rule + 88 test).
 * Kill criterion: none enforced today; retire only by maintainer decision that a single admitted
 *   importer of @agent-device/selectors/engine no longer matters. The exports map makes the
 *   engine resolvable, not private: any module can import the subpath, so only this edge scan
 *   sees a second importer.
 */

/**
 * R19 selector-pipeline-ownership (#1656).
 *
 * The structural stages of selector resolution — occlusion, off-screen,
 * hittable-ancestor promotion, the poll budget — are declared per caller in
 * `src/core/selector-pipeline-policy.ts` and executed by
 * `src/core/selector-pipeline.ts`. That only means something while the owner is
 * the ONLY way in: a route that reaches the matching engine itself still gets a
 * row's ambiguity contract while silently skipping every structural stage,
 * which is how a declared cell turns back into an unverifiable claim (the
 * failure #1649 caught in the first matrix and #1656's review caught in the
 * second).
 *
 * The engine therefore lives behind its own package subpath, and this rule
 * admits one importer. Enforcing on the SPECIFIER, over the resolved import
 * graph, is what makes the boundary hold in every import form: a namespace
 * import, a re-export, and a deferred `import()` are all the same edge, and
 * none of them mentions the symbol a name-shaped check would look for.
 */

export const SELECTOR_ENGINE_SPECIFIER = '@agent-device/selectors/engine';

/** The pipeline owner: the one module that may hold the engine. */
export const SELECTOR_ENGINE_OWNER = 'src/core/selector-pipeline.ts';

/**
 * `resolveImportEdges` DROPS an edge whose specifier resolves to nothing, so a
 * rule keyed on a specifier goes quiet — not red — if that subpath ever stops
 * being an export. The gate says so out loud instead: no resolvable engine
 * door means this rule is not watching anything, which is a failure of the
 * gate rather than a clean scan.
 */
export function selectorPipelineOwnershipViolations(
  edges: readonly ResolvedImportEdge[],
  workspaceTargets?: ReadonlyMap<string, string>,
): LayeringViolation[] {
  if (workspaceTargets && !workspaceTargets.has(SELECTOR_ENGINE_SPECIFIER)) {
    return [
      {
        rule: 'R19 selector-pipeline-ownership',
        file: SELECTOR_ENGINE_OWNER,
        line: 1,
        message:
          `${SELECTOR_ENGINE_SPECIFIER} is not a workspace export, so no import of it resolves ` +
          'and this rule can no longer see a bypass. Restore the subpath export, or retire the ' +
          'rule deliberately — do not leave it watching a door that does not exist.',
      },
    ];
  }
  return edges
    .filter(
      (edge) => edge.spec === SELECTOR_ENGINE_SPECIFIER && edge.file !== SELECTOR_ENGINE_OWNER,
    )
    .map((edge) => ({
      rule: 'R19 selector-pipeline-ownership',
      file: edge.file,
      line: edge.line,
      message:
        `imports ${SELECTOR_ENGINE_SPECIFIER}. The selector engine is owned by ` +
        `${SELECTOR_ENGINE_OWNER}: call resolveSelectorPipeline / listSelectorPipelineMatches / ` +
        'runNodePipelineStages with a SELECTOR_PIPELINE_POLICIES row instead, so this route runs the ' +
        'occlusion, off-screen and promotion stages the row declares rather than skipping them.',
    }));
}
