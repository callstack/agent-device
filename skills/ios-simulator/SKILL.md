---
name: ios-simulator
description: Verify and debug native, React Native, Expo, or Flutter apps on an iOS Simulator with agent-device. Use when an agent needs to launch an app, inspect its live UI, tap, type, scroll, validate a code change, collect failure evidence, or reproduce a workflow on an iPhone or iPad Simulator.
---

# iOS Simulator

Use `agent-device` on an iOS Simulator to verify a running app. Work from the live UI, act on current refs or selectors, and verify the result before closing the session.

For an app or bundle id, open it in the foreground:

```bash
agent-device open <app-or-bundle-id> --platform ios --foreground
```

`open` returns the initial interactive snapshot. Use its current refs or a selector. For a planned action, use `--settle`. If the settled diff shows the next target, continue from it:

```bash
agent-device press @eN --settle
agent-device fill @eN "text" --settle
```

Run `agent-device snapshot -i` only when the settled diff does not show the next target. `type` never takes `--settle`; verify it with a snapshot or named `wait`. Keep state-changing commands serial. Verify the end state with a selector or exact text, then close:

```bash
agent-device close
```

For non-routine work, use the version-matched CLI help:

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

If platform help says a capability is unavailable, follow it. Keep diagnostic output when verification fails.
