import type {
  InteractionGuarantee,
  InteractionPathId,
} from '@agent-device/contracts/interaction-guarantees';

/**
 * ADR 0011 Layer 3: the machine-readable claim of which interaction guarantee
 * matrix cells a scenario file proves. Every `<path>.contract.test.ts` has a
 * sibling `<path>.coverage.ts` exporting one of these manifests (kept out of
 * the test file so the coverage gate can import it without re-registering the
 * scenarios), and `index.ts` aggregates them statically for the gate test in
 * `src/__tests__/contracts/interaction-contract-coverage.test.ts`.
 *
 * Scenario strings double as the vitest test titles. Each contract file calls
 * `assertCoverageClaimsRegistered` (coverage-registration.ts), which fails when
 * a manifest claim names no test registered in that file.
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
