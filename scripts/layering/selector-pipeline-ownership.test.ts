import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  SELECTOR_ENGINE_OWNER,
  selectorPipelineOwnershipViolations,
} from './selector-pipeline-ownership.ts';

function violations(source: string, path = 'src/daemon/handlers/planted.ts'): string[] {
  return selectorPipelineOwnershipViolations([{ path, source }]).map(
    (violation) => `${violation.file}: ${violation.message}`,
  );
}

test('a route that reaches the selector engine directly is rejected', () => {
  for (const source of [
    "import { resolveSelectorChainWithPolicy } from '@agent-device/selectors';",
    "import { listSelectorChainMatches } from '@agent-device/selectors';",
    "import { formatSelectorFailure, resolveSelectorChainWithPolicy } from '@agent-device/selectors';",
    "import { listSelectorChainMatches as listMatches } from '@agent-device/selectors';",
  ]) {
    assert.equal(violations(source).length, 1, source);
  }
});

test('the owner may hold the engine, and everyone may hold the vocabulary around it', () => {
  assert.deepEqual(
    violations(
      "import { resolveSelectorChainWithPolicy } from '@agent-device/selectors';",
      SELECTOR_ENGINE_OWNER,
    ),
    [],
  );
  assert.deepEqual(
    violations("import type { SelectorChainMatchList } from '@agent-device/selectors';"),
    [],
  );
  assert.deepEqual(
    violations(
      [
        "import { buildSelectorChainForNode, formatSelectorFailure } from '@agent-device/selectors';",
        "import { resolveSelectorPipeline } from '../../core/selector-pipeline.ts';",
      ].join('\n'),
    ),
    [],
  );
  // The engine's own package describes the engine rather than routing around it.
  assert.deepEqual(
    violations(
      "import { listSelectorChainMatches } from '@agent-device/selectors';",
      'packages/selectors/src/index.test.ts',
    ),
    [],
  );
});

test('the refusal names the owner and the entry points that replace the bypass', () => {
  const [message] = violations(
    "import { resolveSelectorChainWithPolicy } from '@agent-device/selectors';",
  );
  assert.ok(message?.includes(SELECTOR_ENGINE_OWNER), message);
  assert.ok(message?.includes('resolveSelectorPipeline'), message);
  assert.ok(message?.includes('SELECTOR_PIPELINE_POLICIES'), message);
});
