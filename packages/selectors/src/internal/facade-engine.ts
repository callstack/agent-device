import type { SnapshotState } from '@agent-device/kernel/snapshot';
import { parseSelectorChain } from './parse.ts';
import { listSelectorChainMatches as listSelectorChainMatchesAst } from './resolve.ts';
import { resolveSelectorChainWithPolicy as resolveSelectorChainWithPolicyAst } from './resolve-with-policy.ts';
import type { SelectorResolutionPolicy } from './resolution-policy.ts';
import type {
  PolicyResolutionOutcome,
  SelectorChainMatchList,
  SelectorMatchOptions,
} from './public-resolution-types.ts';

/**
 * The two engine entries, behind `@agent-device/selectors/engine` (#1656).
 * Both are string-in/string-out façade wrappers (#1589): a nested parser node
 * would reopen the AST boundary invisibly, since the package-boundary gate
 * reads exported *names* and cannot see into a returned shape.
 */

/** Public façade wrapper that accepts/returns selector text, never an AST. */
export function listSelectorChainMatches(
  nodes: SnapshotState['nodes'],
  expression: string,
  options: SelectorMatchOptions,
): SelectorChainMatchList | null {
  const result = listSelectorChainMatchesAst(nodes, parseSelectorChain(expression), options);
  return result ? { ...result, selector: result.selector.raw } : null;
}

/**
 * The façade's ONLY selector-resolution entry (#1630): every native consumer
 * of "resolve a selector against the screen" states its contract by naming a
 * `SELECTOR_RESOLUTION_POLICIES` row, because there is no knob-taking resolver
 * here to state it inline with instead. Accepts selector text and returns
 * selector text — never an AST, in either direction.
 *
 * The return leg is the half that is easy to miss: the parser-side outcome
 * carries the winning `Selector` node inside `resolution`, and returning it
 * unchanged would put a package-private parser object back in every caller's
 * hands through a nested field. The façade's own boundary gate reads exported
 * *names*, so it cannot see that; `selector-wait.ts` reading
 * `outcome.resolution.selector.raw` was the runtime proof it had happened.
 * Flattening here is the same treatment `listSelectorChainMatches` above gives
 * its own selector node (#1589).
 */
export function resolveSelectorChainWithPolicy(
  nodes: SnapshotState['nodes'],
  expression: string,
  policy: SelectorResolutionPolicy,
  options: SelectorMatchOptions,
): PolicyResolutionOutcome {
  const outcome = resolveSelectorChainWithPolicyAst(
    nodes,
    parseSelectorChain(expression),
    policy,
    options,
  );
  if (outcome.kind !== 'resolved') return outcome;
  return {
    ...outcome,
    resolution: { ...outcome.resolution, selector: outcome.resolution.selector.raw },
  };
}
