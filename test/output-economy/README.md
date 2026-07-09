# Output-economy contract

This suite measures agent-facing output through existing formatters and response views.

- The committed baseline is the fast deterministic CI tripwire for raw bytes, line counts,
  actionable refs, hints, and response shape.
- The actionability floors keep refs, generation pins, warnings, retry signals, and recovery
  guidance from being optimized away.
- SkillGym and the help-conformance benchmark remain the non-gating small-model outcome oracle:
  byte reductions are not successful when the model needs an extra observation or chooses the
  wrong recovery command.
- `scripts/perf/` remains the non-gating live signal for latency and failure rate across real
  devices. Its failure counts and error identities complement this deterministic contract.

Regenerate the reviewed baseline after an intentional output change:

```sh
UPDATE_OUTPUT_ECONOMY_BASELINE=1 pnpm test:output-economy
```
