# Output-economy contract

This suite measures agent-facing output through existing formatters, response views, and a
representative MCP tool result containing optimized text plus structured content.

- The committed baseline is the fast deterministic CI tripwire for raw bytes, line counts,
  actionable refs, hints, and response shape. Its byte/line budgets are compared with the
  merge-base baseline (or the first baseline introduced on the branch), so a PR cannot raise the
  ceiling it is measured against.
- The actionability floors keep refs, generation pins, warnings, retry signals, and recovery
  guidance from being optimized away.
- SkillGym and the help-conformance benchmark remain the non-gating small-model outcome oracle:
  byte reductions are not successful when the model needs an extra observation or chooses the
  wrong recovery command.
- `scripts/perf/` remains the non-gating live signal for latency and failure rate across real
  devices. Its failure counts and error identities complement this deterministic contract.

Regenerate the reviewed baseline after an intentional reduction or new measured surface:

```sh
UPDATE_OUTPUT_ECONOMY_BASELINE=1 pnpm test:output-economy
```

An intentional semantic addition that raises bytes or lines needs an exact reviewed entry in
`output-economy.waivers.json`, including the resulting metric and a non-empty reason. The update
still fails if the measured result differs from that explicit waiver.
