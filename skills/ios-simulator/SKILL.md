---
name: ios-simulator
description: Verify and debug native, React Native, Expo, or Flutter apps on an iOS Simulator with agent-device. Use when an agent needs to launch an app, inspect its live UI, tap, type, scroll, validate a code change, collect failure evidence, or reproduce a workflow on an iPhone or iPad Simulator.
---

# iOS Simulator

Use `agent-device` to verify a running app on an iOS Simulator. Start from the live UI, act on current refs or selectors, and verify the requested result before closing the session.

For a known app or bundle id, bring the app to the foreground and continue from the returned snapshot:

```bash
agent-device open <app-or-bundle-id> --platform ios --foreground
```

`open` returns the initial interactive snapshot. Use its current refs or a specific selector. For a planned UI action, add `--settle` and continue from the settled diff when it shows the next state:

```bash
agent-device press @eN --settle
agent-device fill @eN "text" --settle
```

Refresh with `agent-device snapshot -i` only when the settled diff does not show the next target. `type` does not support `--settle`; verify it with a snapshot or a named `wait`. Keep state-changing commands serial in one session, verify the requested end state with a selector or exact text, then close it:

```bash
agent-device close
```

Before planning a non-routine workflow, read the installed CLI guidance; it is version-matched and is the source of truth:

```bash
agent-device help validate
```

Read only the relevant follow-up topic for specialized work:

```bash
agent-device help debugging       # screenshots, logs, traces, video, and failures
agent-device help react-native    # React Native and Expo runtime guidance
agent-device help react-devtools  # component tree, props/state/hooks, and renders
agent-device help scripting       # durable replay and CI workflows
```

When target-specific help says capture or selectors are unavailable, follow that help rather than inventing a screenshot-based fallback. Preserve diagnostic output when a verification fails.
