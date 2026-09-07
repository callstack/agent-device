# #2198 slice A: the two harness-fixed first-interaction cells

The `list` and `system-surface` first-interaction cells of the slice A corpus (`../2198-slice-a-7616ba222d/`) were harness-invalid on both legs: the harness pressed the screen's anchor text, which names two actionable elements there, and the CLI refused that as `AMBIGUOUS_MATCH` by design. The harness now presses `id="catalog-search"` on the catalog screen and `text="General"` on iOS Settings (agent-device commit adec882247). These are those two cells re-run with the fixed harness, 10 samples each, same Simulator (`ad-bench-2198`, iOS 26.2) and host as the corpus, 1-minute load 9–11.

- Base production code: `27a97ee619` (`dist` built from it; harness copied from head).
- Head production code: `e729321dcc` (`dist` built from it).

| File | Leg |
|---|---|
| `base-first-fixed.json` | base |
| `head-first-fixed.json` | head |

`SHA256SUMS` lists each file's digest.
