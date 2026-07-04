import type {
  InteractionGuarantee,
  InteractionPathId,
} from '../../../src/contracts/interaction-guarantees.ts';

/**
 * ADR 0011 Layer 3: the machine-readable claim of which interaction guarantee
 * matrix cells a scenario file proves. Every `<path>.contract.test.ts` has a
 * sibling `<path>.coverage.ts` exporting one of these manifests (kept out of
 * the test file so the coverage gate can import it without re-registering the
 * scenarios), and `index.ts` aggregates them statically for the gate test in
 * `src/contracts/__tests__/interaction-contract-coverage.test.ts`.
 *
 * Scenario strings double as the vitest test titles — the test files derive
 * their titles from the manifest (via `scenarioName`/`scenarioNames`), so a
 * claim without a matching scenario cannot be written by accident.
 */
export type ContractCoverageEntry = {
  path: InteractionPathId;
  guarantee: InteractionGuarantee;
  scenario: string;
};

export function definePathCoverage(
  path: InteractionPathId,
  scenarios: Partial<Record<InteractionGuarantee, string | readonly string[]>>,
): readonly ContractCoverageEntry[] {
  return Object.entries(scenarios).flatMap(([guarantee, names]) =>
    (typeof names === 'string' ? [names] : (names ?? [])).map((scenario) => ({
      path,
      guarantee: guarantee as InteractionGuarantee,
      scenario,
    })),
  );
}

export function scenarioNames(
  coverage: readonly ContractCoverageEntry[],
  guarantee: InteractionGuarantee,
): string[] {
  const names = coverage
    .filter((entry) => entry.guarantee === guarantee)
    .map((entry) => entry.scenario);
  if (names.length === 0) {
    throw new Error(`no contract scenario declared for guarantee "${guarantee}"`);
  }
  return names;
}

export function scenarioName(
  coverage: readonly ContractCoverageEntry[],
  guarantee: InteractionGuarantee,
): string {
  return scenarioNames(coverage, guarantee)[0]!;
}
