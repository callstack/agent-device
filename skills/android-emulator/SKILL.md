---
name: android-emulator
description: Verify and debug native, React Native, Expo, or Flutter apps on an Android Emulator with agent-device. Use when an agent needs to launch an app, inspect its live UI, tap, type, scroll, validate a code change, collect failure evidence, or reproduce a workflow on an Android virtual device.
---

# Android Emulator

Require the `agent-device` CLI to be installed separately before driving an emulator:

```bash
npm install -g agent-device@latest
```

Treat installation and upgrades as user-owned setup steps. Do not run that command autonomously or substitute a mutable `npx -y agent-device@latest` invocation.

For a normal app-driving task, start immediately. Do not probe first with `--help`, `--version`, `devices`, `appstate`, `snapshot`, or `screenshot`. Target Android explicitly when opening an app or package id:

```bash
agent-device open <app-or-package-id> --platform android --foreground
```

Follow the initial interactive snapshot and corrective error hints. If the shell reports that `agent-device` is unavailable, stop and ask the user to install it or expose their existing installation on `PATH`.

Only when the task is specialized or a command shape is unclear, read the relevant version-matched help topic:

```bash
agent-device help validate        # engineering validation and build freshness
agent-device help debugging       # screenshots, logs, traces, video, and failures
agent-device help react-native    # React Native and Expo runtime guidance
agent-device help react-devtools  # component tree, props/state/hooks, and renders
agent-device help scripting       # durable replay and CI workflows
```
