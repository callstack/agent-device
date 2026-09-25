---
name: test-audit
description: Write, change, review, or sweep tests. Use when authoring new tests, auditing existing tests that cannot fail or duplicate proof, or dispatching parallel read-only test-audit subagents.
---

# Test audit

Read `docs/agents/test-audit.md` before adding or deleting a test. It holds the authoring gate, the junk-pattern catalog, the retention criteria that refuse a deletion, the candidate evidence fields, and the focused validation commands.

The one non-negotiable: never argue that a test already detects something or can be deleted — measure it. Plant the production edit representing the claimed bug, show the pre-edit body green and the post-edit body red with both counts, revert, and show `git status` clean.

Dispatch parallel lanes read-only with exclusive edit ownership, paste the retention list into every prompt, and treat a false positive as costing more than a miss.
