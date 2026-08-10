---
name: ios-simulator
description: Verify and debug native, React Native, Expo, or Flutter apps on an iOS Simulator with agent-device. Use when an agent needs to launch an app, inspect its live UI, tap, type, scroll, validate a code change, collect failure evidence, or reproduce a workflow on an iPhone or iPad Simulator.
---

# iOS Simulator

Use `agent-device` as the inspect-act-verify layer for iOS Simulator work. It provides an interactive accessibility snapshot with current UI references, so do not guess coordinates or infer state from a screenshot alone.

For a known app or bundle id, bring the app to the foreground and continue from the returned snapshot:

```bash
agent-device open <app-or-bundle-id> --platform ios --foreground
```

Use a current `@eN` reference or a specific selector for interactions. After every mutation, verify the resulting state with the returned snapshot or a new interactive snapshot. Keep a session's mutations serial, then close the session when verification is complete.

```bash
agent-device snapshot -i
agent-device click @eN
agent-device fill @eN "text"
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
