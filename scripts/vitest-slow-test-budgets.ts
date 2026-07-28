// The slow-test ratchet's budgets, as a single source of truth (see docs/agents/testing.md
// "Speed rules"). Kept in a data-only module so consumers that only need the numbers — the
// repo-health snapshot (scripts/repo-health), which records them as observatory data — can import
// them without pulling the vitest reporter (a config-loaded module) into their dependency graph.

// Unit tests must not wait real time; integration scenarios drive a real daemon request path and
// get more room.
export const UNIT_BUDGET_MS = 2_500;
export const INTEGRATION_BUDGET_MS = 15_000;

// Enforcement fires at 2x budget: host load legitimately stretches a borderline test by tens of
// percent, and a wall-clock gate that flakes under contention trains people to ignore it. Between
// budget and 2x budget the gate reports without failing.
export const ENFORCE_FACTOR = 2;

/** The ratchet as one record, for callers that report it rather than enforce it. */
export const SLOW_TEST_RATCHET = {
  unitBudgetMs: UNIT_BUDGET_MS,
  integrationBudgetMs: INTEGRATION_BUDGET_MS,
  enforceFactor: ENFORCE_FACTOR,
} as const;
