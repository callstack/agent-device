# Audit tests

Optimize for confidence, not deletion counts.
For test quality, use [test authoring](test-authoring.md).
For checks, use [validation](testing.md).

## Retain independent contracts

Do not delete completeness guards for registries, gates, layering, or DI seams.
Retain these contracts:

- Golden tables.
- Cross-language inspection.
- `@ts-expect-error` pins.
- Identity checks.
- Exact-array checks that detect duplicates.
- Vocabulary checks that survive a simultaneous production/fixture update.

Without measured evidence, slow or implementation-like tests are not redundant.

## Candidate evidence

Before you edit, record:

- The location, name, and detectable failure.
- Production callers and the stronger remaining test's assertions, with locations.
- Candidate and sibling skip guards, including workflow environment flags.
- The actual runner: Vitest project, Node script, XCTest lane, or gate id.
- What deletion permits and its risk.

Only unreachable tests are never-run findings.
For mutations, use [isolated experiments](test-experiments.md).
For a deletion, remove the candidate. Prove the retained test still detects the mutant.
Report baseline and mutant counts. Source inspection alone does not prove detection.

## Delegated audits

Assign disjoint read scopes to read-only reviewers.
Do not assign edit ownership to a reviewer.
Each brief names the reviewed SHA. Each brief requires:

- Inspection of the production owner.
- Skip/runner verification.
- Retention criteria.
- Concrete failure scenarios.

Experiments use separate disposable checkouts.
When needed, use separate scopes for subsystem review, duplicate-pattern search, and runner inventory.

Put one batch for one owner boundary in each PR.
Remove unused test-only seams with the tests.
Report retained false positives.
After a relevant rebase, repeat discovery.
