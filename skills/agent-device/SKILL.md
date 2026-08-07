---
name: agent-device
description: Automates Apple-platform apps (iOS, tvOS, macOS), Android devices, and Amazon Vega OS TV apps in Vega Virtual Devices. Use when navigating apps, taking snapshots/screenshots where supported, driving TV remotes, tapping, typing, scrolling, extracting UI info, collecting evidence, or planning agent-device CLI commands.
---

# agent-device

Router only. Before your first agent-device command or plan, read the smallest version-matched CLI guide that fits the task — this single read also replaces a separate `agent-device --version` check:

```bash
agent-device help manual-qa   # scripted/manual QA, acceptance checks, checklist execution
agent-device help validate    # code/runtime validation, stale build or daemon risk
agent-device help dogfood     # exploratory app dogfooding and evidence collection
agent-device help workflow    # fallback reference for general app driving or mixed tasks
```

That topic's first line is `agent-device <version> — <topic>` (for example `agent-device 0.21.0 — workflow`). Read the version from it instead of running `agent-device --version` separately. If the first line instead reads `agent-device help <topic>` with no version — or the command fails, or the topic is unrecognized — the installed CLI predates this header and its current help topics/Vega OS routing. Stop and tell the user to upgrade the trusted install or approve an exact-version npm command. Do not run `npm install -g agent-device@latest` or `npx -y agent-device@latest` autonomously, and do not include version/upgrade commands in final plans.

If `agent-device` fails outright but the user may have installed it globally, check the user's configured login/interactive shell and environment before using `npx`. Resolve the command the same way the user would from a normal terminal session, then run the absolute binary path if found. This may require inspecting shell startup behavior or package-manager/global bin locations; do not assume the Codex process `PATH` is the user's `PATH`.

Read additional topics only when relevant:

```bash
agent-device help debugging
agent-device help scripting      # save-script, secret-safe fills, batch JSON, replay repair
agent-device help gestures       # multi-touch gesture shapes and platform quirks
agent-device help react-native
agent-device help react-devtools
agent-device help cdp
agent-device help remote
agent-device help macos
agent-device help dogfood
agent-device help tv
agent-device help ios-system-ui  # iOS SpringBoard, widgets, and system-UI surfaces
```

Default loop: `open -> snapshot/-i -> get/is/find or press/fill/scroll/wait -> verify -> close`. When target-specific help says capture or selectors are unsupported, use its control-only loop and the device display as visual truth.

Use this skill only to route into version-matched CLI help. Let the selected help topic provide exact command shapes, platform limits, and current workflow guidance; use `help workflow` as the full reference when a task-specific topic is too narrow.

For precise location workflows, read the installed `settings` help before planning so coordinate support and platform limits come from the active CLI version.
