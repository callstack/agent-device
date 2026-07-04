import { test } from 'vitest';
import assert from 'node:assert/strict';
import {
  INTERACTION_DISPATCH_PATHS,
  INTERACTION_GUARANTEES,
  INTERACTION_PATH_IDS,
} from '../interaction-guarantees.ts';
import { CONTRACT_COVERAGE } from '../../../test/integration/interaction-contract/index.ts';

// ADR 0011 Layer-3 gate: the contract scenario suite is registry-driven. Every
// matrix cell that claims enforcement (runtime, runner, or delegated) must be
// proven by at least one scenario in test/integration/interaction-contract/,
// and no scenario may claim a waived or inapplicable cell — coverage of the
// matrix is by construction, not reviewer memory, in both directions.

const ENFORCED_KINDS: ReadonlySet<string> = new Set(['runtime', 'runner', 'delegated']);

function cellKey(pathId: string, guarantee: string): string {
  return `${pathId}/${guarantee}`;
}

test('contract coverage entries reference real matrix cells and named scenarios', () => {
  for (const entry of CONTRACT_COVERAGE) {
    assert.ok(
      (INTERACTION_PATH_IDS as readonly string[]).includes(entry.path),
      `coverage entry references unknown path "${entry.path}"`,
    );
    assert.ok(
      (INTERACTION_GUARANTEES as readonly string[]).includes(entry.guarantee),
      `coverage entry references unknown guarantee "${entry.guarantee}"`,
    );
    assert.ok(
      entry.scenario.trim().length > 10,
      `${cellKey(entry.path, entry.guarantee)}: scenario name must describe what it proves`,
    );
  }
});

test('contract coverage never claims a waived or inapplicable cell', () => {
  for (const entry of CONTRACT_COVERAGE) {
    const enforcement = INTERACTION_DISPATCH_PATHS[entry.path].guarantees[entry.guarantee];
    // Overclaiming is an error too: a scenario tagged onto a waived cell would
    // make the debt list look repaid without flipping the matrix cell.
    assert.ok(
      ENFORCED_KINDS.has(enforcement.kind),
      `${cellKey(entry.path, entry.guarantee)} is "${enforcement.kind}" — drop the coverage entry or flip the matrix cell in the same PR`,
    );
  }
});

test('every enforced matrix cell has at least one contract scenario', () => {
  const covered = new Set(CONTRACT_COVERAGE.map((entry) => cellKey(entry.path, entry.guarantee)));
  const missing: string[] = [];
  for (const pathId of INTERACTION_PATH_IDS) {
    for (const guarantee of INTERACTION_GUARANTEES) {
      const enforcement = INTERACTION_DISPATCH_PATHS[pathId].guarantees[guarantee];
      if (!ENFORCED_KINDS.has(enforcement.kind)) continue;
      if (!covered.has(cellKey(pathId, guarantee))) missing.push(cellKey(pathId, guarantee));
    }
  }
  assert.deepEqual(
    missing,
    [],
    'enforced matrix cells without a contract scenario — add one under test/integration/interaction-contract/ and register its manifest in index.ts',
  );
});
