# Audit tests

Optimize detection and feedback time, not deletion count.
For test quality, use [test authoring](test-authoring.md).

## Retain independent contracts

Never delete independent completeness guards for registries, gates, layering, or DI seams.
Keep golden tables, cross-language checks, `@ts-expect-error` pins, identity checks,
exact-array duplicate checks, and vocabulary checks that survive a simultaneous production/fixture update.

For duplicated command behavior, move the mock's unique assertions to the provider scenario.
With the mock removed, prove the scenario catches the same mutant.
After detection is proven, delete the weaker mock.
Source inspection alone does not prove detection.
Slow or implementation-like tests are not redundant without measured evidence.
If only a device exposes the failure, retain an owned E2E scenario.

## Candidate evidence

Before you edit, record the location, name, and detectable failure; production callers and the stronger test's assertions, with locations; candidate and sibling skip guards, including workflow environment flags; the actual runner (Vitest project, Node script, XCTest lane, or gate id); and what deletion permits and risks.

Before a never-run deletion, prove non-collection or skipping in every automatic and manual lane.
Report baseline and mutant counts.
For an obsolete test with no remaining contract, record consumer and runner evidence.

## Delegated audits

Assign disjoint review scopes.
Name the reviewed SHA in each brief.
Require production-owner inspection, skip/runner verification, retention criteria, and concrete failure scenarios.
Do not assign edit ownership to a reviewer.

Put one owner-boundary batch in each PR.
Remove unused test-only seams with the tests.
Report retained false positives.
After a relevant rebase, repeat discovery.
