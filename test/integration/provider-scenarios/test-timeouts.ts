// These scenarios construct complete in-process daemon/provider fixtures. In
// Vitest's default parallel workload, module transforms and sibling workers
// can delay their valid setup beyond the general 5s unit-test budget. Keep
// the exception at the affected scenarios rather than relaxing a whole test
// project. Measured on 2026-07-30: the parallel tail reached 4.8s.
export const PARALLEL_PROVIDER_SCENARIO_TIMEOUT_MS = 10_000;
