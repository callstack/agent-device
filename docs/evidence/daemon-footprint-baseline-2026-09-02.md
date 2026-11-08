# Daemon footprint baseline, 2026-09-02

The pre-migration daemon top-level footprint measured 199 production TypeScript files, excluding tests, at [the baseline commit](https://github.com/callstack/agent-device/commit/e624ef9d3f5c30be7a4f7597fd6bd74dd61336e3). This historical measurement informs the proposed target in [ADR 0019](../adr/0019-request-bound-platform-runtime.md); it is not a current file count or accepted budget.

The count is the number of top-level `.ts` files directly in `src/daemon/`, not recursive, measured with:

```sh
git ls-tree --name-only e624ef9d3f src/daemon/ | grep -E '\.ts$' | grep -vE '\.test\.ts$' | wc -l
```

That directory no longer exists: the daemon now lives in layer folders under `packages/daemon/src/`, which has one top-level production file. So the old measure does not apply to the current layout, and the ≤60 target needs a new counting rule.
