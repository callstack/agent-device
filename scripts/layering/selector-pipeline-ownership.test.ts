import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseImports, type ResolvedImportEdge } from './model.ts';
import {
  SELECTOR_ENGINE_OWNER,
  SELECTOR_ENGINE_SPECIFIER,
  selectorPipelineOwnershipViolations,
} from './selector-pipeline-ownership.ts';

/**
 * The rule reads resolved edges, so these drive real source through the same
 * `parseImports` the gate uses. That is the point of the shape: a bypass is
 * only refused in every import FORM if the check never looks at symbol names.
 */
function violations(source: string, file = 'src/daemon/handlers/planted.ts'): string[] {
  const edges: ResolvedImportEdge[] = parseImports(source).map((edge) => ({
    ...edge,
    file,
    target: edge.spec,
    fromZone: 'daemon-server',
    toZone: 'selectors',
  }));
  return selectorPipelineOwnershipViolations(edges).map((violation) => violation.message);
}

test('every import form that reaches the engine is refused', () => {
  for (const source of [
    // Named — the shape a symbol-matching check would also have caught.
    `import { resolveSelectorChainWithPolicy } from '${SELECTOR_ENGINE_SPECIFIER}';`,
    // Namespace: no symbol name appears anywhere in the statement.
    `import * as engine from '${SELECTOR_ENGINE_SPECIFIER}';`,
    // Deferred: the call site is a promise, and the specifier is the only trace.
    `const engine = await import('${SELECTOR_ENGINE_SPECIFIER}');`,
    // Re-export: launders the engine through a module the routes may import.
    `export { listSelectorChainMatches } from '${SELECTOR_ENGINE_SPECIFIER}';`,
    `export * from '${SELECTOR_ENGINE_SPECIFIER}';`,
    // Side-effect import, for completeness of the edge kinds the model emits.
    `import '${SELECTOR_ENGINE_SPECIFIER}';`,
    // Type position still names the module the row exists to qualify.
    `import type { SelectorChainMatchList } from '${SELECTOR_ENGINE_SPECIFIER}';`,
  ]) {
    assert.equal(violations(source).length, 1, source);
  }
});

test('the owner holds the engine, and the root façade stays open to everyone', () => {
  assert.deepEqual(
    violations(
      `import { resolveSelectorChainWithPolicy } from '${SELECTOR_ENGINE_SPECIFIER}';`,
      SELECTOR_ENGINE_OWNER,
    ),
    [],
  );
  assert.deepEqual(
    violations(
      [
        "import { buildSelectorChainForNode, formatSelectorFailure } from '@agent-device/selectors';",
        "import type { SelectorChainMatchList } from '@agent-device/selectors';",
        "import { resolveSelectorPipeline } from '../../core/selector-pipeline.ts';",
      ].join('\n'),
    ),
    [],
  );
  // A neighbouring subpath is a different door; only the engine is reserved.
  assert.deepEqual(
    violations("import { parseSelectorChain } from '@agent-device/selectors/ast';"),
    [],
  );
});

test('a missing engine door fails the gate instead of silencing it', () => {
  // The specifier is the whole enforcement, and `resolveImportEdges` drops an
  // edge that resolves to nothing: without this, retiring the subpath would
  // turn the rule green forever.
  const [message] = selectorPipelineOwnershipViolations([], new Map()).map((v) => v.message);
  assert.ok(message?.includes('not a workspace export'), message);
  assert.deepEqual(
    selectorPipelineOwnershipViolations([], new Map([[SELECTOR_ENGINE_SPECIFIER, 'x.ts']])),
    [],
  );
});

test('the refusal names the owner and the entries that replace the bypass', () => {
  const [message] = violations(`import * as engine from '${SELECTOR_ENGINE_SPECIFIER}';`);
  assert.ok(message?.includes(SELECTOR_ENGINE_OWNER), message);
  assert.ok(message?.includes('resolveSelectorPipeline'), message);
  assert.ok(message?.includes('SELECTOR_PIPELINE_POLICIES'), message);
});
