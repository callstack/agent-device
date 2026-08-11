/**
 * The matching engine's own door (#1656).
 *
 * "Resolve a selector against a screen" and "list what it matched" are the two
 * decisions a pipeline policy row exists to qualify: which nodes may be
 * candidates, whether several matches refuse or collapse, and which structural
 * stages run around the answer. A caller that reaches these directly gets the
 * ambiguity contract and silently skips every structural stage — the failure
 * #1649 caught in the first policy matrix and #1656's review caught in the
 * second.
 *
 * So they live behind a subpath of their own rather than on the root façade,
 * and R19 selector-pipeline-ownership admits exactly one importer:
 * `src/core/selector-pipeline.ts`. A specifier is what the import graph
 * resolves, so namespace imports, dynamic imports, and re-exports are all the
 * same edge and all equally refused — which a name-shaped check could not say.
 *
 * Everything else selectors publishes (parsing, matching, formatting, replay)
 * stays on the root façade: none of it decides what a row decides.
 */
export {
  listSelectorChainMatches,
  resolveSelectorChainWithPolicy,
} from './internal/facade-engine.ts';
