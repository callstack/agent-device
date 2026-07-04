import type { ContractCoverageEntry } from './coverage-manifest.ts';
import { COORDINATE_COVERAGE } from './coordinate.coverage.ts';
import { DIRECT_IOS_SELECTOR_COVERAGE } from './direct-ios-selector.coverage.ts';
import { MAESTRO_FALLBACK_COVERAGE } from './maestro-fallback.coverage.ts';
import { NATIVE_REF_COVERAGE } from './native-ref.coverage.ts';
import { RUNTIME_REF_COVERAGE } from './runtime-ref.coverage.ts';
import { RUNTIME_SELECTOR_COVERAGE } from './runtime-selector.coverage.ts';

/**
 * Static aggregation of every scenario file's coverage manifest (no dynamic
 * globbing — a new scenario file must be added here, and the coverage gate in
 * src/contracts/__tests__/interaction-contract-coverage.test.ts fails when an
 * enforced matrix cell has no entry).
 */
export const CONTRACT_COVERAGE: readonly ContractCoverageEntry[] = [
  ...RUNTIME_SELECTOR_COVERAGE,
  ...RUNTIME_REF_COVERAGE,
  ...NATIVE_REF_COVERAGE,
  ...COORDINATE_COVERAGE,
  ...DIRECT_IOS_SELECTOR_COVERAGE,
  ...MAESTRO_FALLBACK_COVERAGE,
];

export type { ContractCoverageEntry } from './coverage-manifest.ts';
