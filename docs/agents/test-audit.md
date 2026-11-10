# Audit tests

Optimize for detection and feedback time, not deletion counts.
For test quality, use [test authoring](test-authoring.md).
For checks, use [validation](testing.md).

## Retain independent contracts

Never delete independent completeness guards for registries, gates, layering, or DI seams.
Retain golden tables, cross-language checks, `@ts-expect-error` pins, identity checks,
exact-array duplicate checks, and vocabulary checks independent of the implementation.

If a mutant proves equivalent detection, move the mock's unique assertions into the provider scenario.
Then delete the weaker mock.
Source inspection alone does not prove detection.
Without measured evidence, slow or implementation-like tests are not redundant.
If only a device exposes the failure, retain an owned E2E scenario.
Keep focused tests for exhaustive logic and independent contracts.

## Candidate evidence

Before you edit, record:

- The location, name, and detectable failure.
- Production callers and the stronger remaining test's assertions, with locations.
- Candidate and sibling skip guards, including workflow environment flags.
- The actual runner: Vitest project, Node script, XCTest lane, or gate id.
- What deletion permits and its risk.

Before a never-run deletion, prove non-collection or skipping in every automatic and manual lane.
For mutations, use [isolated experiments](test-experiments.md).
For a behavioral deletion, prove retained detection with the candidate removed.
Report baseline and mutant counts.
For an obsolete test with no remaining contract, record consumer and runner evidence.

## Delegated audits

Assign disjoint read scopes to read-only reviewers.
Each brief names the reviewed SHA, production owner, runner, skip guards, retention criteria, and failure.

Put one batch for one owner boundary in each PR.
Remove unused test-only seams with the tests.
Report retained false positives.
After a relevant rebase, repeat discovery.
