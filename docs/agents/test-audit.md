# Audit tests

Optimize for confidence, not deletion counts.
Use [test authoring](test-authoring.md) for test quality and [validation](testing.md) for checks.

## Retain independent contracts

Do not delete completeness guards for registries, gates, layering, or DI seams.
Retain golden tables, cross-language inspection, `@ts-expect-error` pins, identity checks,
exact-array checks that detect duplicates, and vocabulary checks surviving a production/fixture co-update.
A slow or implementation-like test is not redundant without measured evidence.

## Candidate evidence

Before editing, record:

- Location, name, and detectable failure.
- Production callers and the stronger remaining test's assertions, with locations.
- Candidate and sibling skip guards, including workflow environment flags.
- Actual runner: Vitest project, Node script, XCTest lane, or gate id. Only unreachable tests are never-run findings.
- What deletion unlocks and its risk.

Use [isolated experiments](test-experiments.md) for mutations.
For a deletion, prove the retained test detects the mutant after removing the candidate.
Report baseline and mutant counts. Source inspection alone does not prove detection.

## Delegated audits

Assign disjoint read scopes to read-only reviewers. Do not assign edit ownership to a reviewer.
Each brief names the reviewed SHA and requires production-owner inspection, skip/runner verification,
retention criteria, and concrete failure scenarios. Experiments use separate disposable checkouts.
Subsystem review, duplicate-pattern search, and runner inventory are separate scopes when needed.

Land one owner-boundary batch per PR. Remove unused test-only seams with the tests.
Report retained false positives. Rediscover after a relevant rebase.
