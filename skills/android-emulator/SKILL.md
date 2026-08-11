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

Before emulator work, confirm the trusted CLI is available:

```bash
agent-device --version
```

If that fails, stop and ask the user to install `agent-device` or expose their existing installation on `PATH`.

Read the installed CLI's version-matched routine QA workflow before planning commands:

```bash
agent-device help manual-qa
```

Target Android explicitly when opening an app or package id:

```bash
agent-device open <app-or-package-id> --platform android --foreground
```

Also read the validation workflow when the task covers a code change or regression:

```bash
agent-device help validate
```

Read only the relevant follow-up topic for specialized work; the installed help owns command shapes and platform limits:

```bash
agent-device help debugging       # screenshots, logs, traces, video, and failures
agent-device help react-native    # React Native and Expo runtime guidance
agent-device help react-devtools  # component tree, props/state/hooks, and renders
agent-device help scripting       # durable replay and CI workflows
```
