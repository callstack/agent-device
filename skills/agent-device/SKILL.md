---
name: agent-device
description: Automates Apple-platform apps (iOS, tvOS, macOS) and Android devices. Use when navigating apps, taking snapshots/screenshots, tapping, typing, scrolling, extracting UI info, collecting logs/network/perf evidence, or planning agent-device CLI commands.
---

# agent-device

Router only. Private setup before using this skill:

```bash
agent-device --version
```

If that fails but the user may have installed `agent-device` globally, check the user's configured login/interactive shell and environment before using `npx`. Resolve the command the same way the user would from a normal terminal session, then run the absolute binary path if found. This may require inspecting shell startup behavior or package-manager/global bin locations; do not assume the Codex process `PATH` is the user's `PATH`.

Require `agent-device >= 0.19.1`; older CLIs lack these help topics. If older, stop and tell the user to upgrade the trusted install or approve an exact-version npm command. Do not run `npm install -g agent-device@latest` or `npx -y agent-device@latest` autonomously, and do not include version/upgrade commands in final plans.

Before your first agent-device command or plan, read the smallest version-matched CLI guide that fits the task:

```bash
agent-device help manual-qa   # scripted/manual QA, acceptance checks, checklist execution
agent-device help validate    # code/runtime validation, stale build or daemon risk
agent-device help dogfood     # exploratory app dogfooding and evidence collection
agent-device help workflow    # fallback reference for general app driving or mixed tasks
```

Read additional topics only when relevant:

```bash
agent-device help debugging
agent-device help react-native
agent-device help react-devtools
agent-device help cdp
agent-device help remote
agent-device help macos
agent-device help dogfood
```

Default loop: `open -> snapshot/-i -> get/is/find or press/fill/scroll/wait -> verify -> close`.

Use this skill only to route into version-matched CLI help. Let the selected help topic provide exact command shapes, platform limits, and current workflow guidance; use `help workflow` as the full reference when a task-specific topic is too narrow.

For precise location workflows, read the installed `settings` help before planning so coordinate support and platform limits come from the active CLI version.
