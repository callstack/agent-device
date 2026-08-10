---
name: android-emulator
description: Verify and debug native, React Native, Expo, or Flutter apps on an Android Emulator with agent-device. Use when an agent needs to launch an app, inspect its live UI, tap, type, scroll, validate a code change, collect failure evidence, or reproduce a workflow on an Android virtual device.
---

# Android Emulator

Use `agent-device` as the inspect-act-verify layer for Android Emulator work. It wraps platform tooling such as ADB but gives the agent a concise interactive accessibility snapshot and semantic UI references, instead of making it reason over shell output, full trees, or screenshots alone.

For a known app or package id, bring the app to the foreground and continue from the returned snapshot:

```bash
agent-device open <app-or-package-id> --platform android --foreground
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

Use raw `adb shell` only for platform operations that require it. For app verification, prefer the snapshot-driven loop so the agent can ground each action in the actual UI and retain evidence when it fails.
