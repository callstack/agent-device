# Daemon session authority at the 0.22 baseline

At `bdf5096f7738dda205d77f293189b1a72f8f83e1`, there are 193 direct reads in 78 package source files. The count excludes tests and fixtures. It counts the named `sessionStore` receiver only. Aliases such as `store` are outside this baseline count.

```sh
git grep -o -E 'sessionStore\.(get|lookup|requireCurrent|resolveCurrent|listRefs|findByDevice|toArray)\(' \
  bdf5096f -- 'packages/*/src/**' ':!**/__tests__/**' ':!**/*.test.*' ':!**/fixtures/**' ':!**/*.fixtures.*' \
  | wc -l
```

| Current path | Evidence at the baseline |
| --- | --- |
| Store access and replay | The store offers [address reads](https://github.com/callstack/agent-device/blob/bdf5096f/packages/daemon/src/core/session-store.ts#L93) and [journal access by name](https://github.com/callstack/agent-device/blob/bdf5096f/packages/daemon/src/core/session-store.ts#L250). Replay [binds address-based operations](https://github.com/callstack/agent-device/blob/bdf5096f/packages/daemon/src/sessions/handlers/session-replay-command.ts#L171). |
| First lease binding | The [existing-session open path](https://github.com/callstack/agent-device/blob/bdf5096f/packages/daemon/src/sessions/session-lifecycle/internal/session-open-state.ts#L51-L77) assigns a first lease with `??=`. |
| Expiry and provider release | [The registry's sweep](https://github.com/callstack/agent-device/blob/bdf5096f/packages/daemon/src/resources/lease-registry.ts#L613) removes the lease. [The expiry callback](https://github.com/callstack/agent-device/blob/bdf5096f/packages/daemon/src/server/http/daemon-runtime.ts#L281) starts provider release and session teardown separately. |
| Session effects and outputs | [The script publisher](https://github.com/callstack/agent-device/blob/bdf5096f/packages/daemon/src/core/session-script-publication-capability.ts#L294) resolves the session by address. [Finalization](https://github.com/callstack/agent-device/blob/bdf5096f/packages/daemon/src/server/request-finalization.ts#L93) registers artifact paths and can infer their tenant. |
