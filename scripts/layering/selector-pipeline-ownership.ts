/**
 * R17 selector-pipeline ownership (#1656).
 *
 * The structural stages of selector resolution — occlusion, off-screen,
 * hittable-ancestor promotion, the poll budget — are declared per caller in
 * `src/core/selector-pipeline-policy.ts` and executed by
 * `src/core/selector-pipeline.ts`. That only means something while the owner is
 * the ONLY way in: a route that calls the matching engine directly still gets a
 * row's ambiguity contract while silently skipping every structural stage,
 * which is how a declared cell turns back into an unverifiable claim (the
 * failure #1649 caught in the first matrix and #1656's review caught in the
 * second).
 *
 * So the engine entry points are owner-only. A structural gate rather than a
 * convention, because the failure is invisible at the call site: code that
 * skips the stages looks exactly like code that runs them.
 */

export type SourceFile = { path: string; source: string };

export type LayeringViolation = {
  rule: string;
  file: string;
  line: number;
  message: string;
};

/**
 * The engine surface that resolves or enumerates a selector against a tree —
 * the decision a policy row exists to qualify. `@agent-device/selectors` also
 * exports parsing, matching and formatting helpers, which carry no row
 * semantics and stay freely importable.
 */
export const OWNED_SELECTOR_ENGINE_SYMBOLS = [
  'resolveSelectorChainWithPolicy',
  'listSelectorChainMatches',
] as const;

/** The pipeline owner. The selectors package implements the engine it wraps. */
export const SELECTOR_ENGINE_OWNER = 'src/core/selector-pipeline.ts';

const IMPORT_BLOCK =
  /import\s+(type\s+)?\{([^}]*)\}\s*from\s*['"](@agent-device\/selectors[^'"]*)['"]/g;

export function selectorPipelineOwnershipViolations(
  files: readonly SourceFile[],
): LayeringViolation[] {
  const violations: LayeringViolation[] = [];
  for (const file of files) {
    if (file.path === SELECTOR_ENGINE_OWNER) continue;
    // The engine's own package and its tests describe the engine rather than
    // route around it; the gate governs consumers.
    if (file.path.startsWith('packages/selectors/')) continue;
    for (const match of file.source.matchAll(IMPORT_BLOCK)) {
      // A type-only import cannot call anything, and routes legitimately name
      // the result types the owner hands back.
      if (match[1]) continue;
      for (const symbol of importedValueSymbols(match[2] ?? '')) {
        if (!(OWNED_SELECTOR_ENGINE_SYMBOLS as readonly string[]).includes(symbol)) continue;
        violations.push({
          rule: 'R17 selector-pipeline-ownership',
          file: file.path,
          line: lineOf(file.source, match.index ?? 0),
          message:
            `imports ${symbol} from @agent-device/selectors. The selector engine is owned by ` +
            `${SELECTOR_ENGINE_OWNER}: call resolveSelectorPipeline / listSelectorPipelineMatches / ` +
            'runNodePipelineStages with a SELECTOR_PIPELINE_POLICIES row instead, so this route runs ' +
            'the occlusion, off-screen and promotion stages the row declares rather than skipping them.',
        });
      }
    }
  }
  return violations;
}

function importedValueSymbols(names: string): string[] {
  return names
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0 && !entry.startsWith('type '))
    .map((entry) => entry.split(/\s+as\s+/)[0]?.trim() ?? '');
}

function lineOf(source: string, index: number): number {
  return source.slice(0, index).split('\n').length;
}
