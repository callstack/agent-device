---
name: agent-device
description: Automates Apple-platform apps (iOS, tvOS, macOS), Android devices, and Amazon Vega OS TV apps in Vega Virtual Devices. Use when navigating apps, taking snapshots/screenshots where supported, driving TV remotes, tapping, typing, scrolling, extracting UI info, collecting evidence, or planning agent-device CLI commands.
---

# agent-device

For an ordinary app-driving task with a known app or bundle id, start directly. Do not run `--help`, `--version`, `appstate`, or `snapshot` first:

```bash
agent-device open <app> --foreground
```

`open <app> --foreground` keeps normal configured target selection and returns the initial interactive snapshot in the same call. Continue from its current refs. Prefer a concrete `@eN` ref from the current snapshot over a broad mutation selector. When a response prints a pinned ref such as `@e12~s42` — including an ambiguity candidate or settled diff — copy the whole pinned ref exactly; a bare ref from a partial result is intentionally rejected.

Default loop: `open -> act with a current ref or specific selector -> verify -> close`. Use `--settle` on planned `press`, `click`, `fill`, `longpress`, `scroll`, or `back`; continue from the settled diff when it already proves the next state. If a mutation returns `AMBIGUOUS_MATCH`, retry one listed pinned candidate rather than adding `--first` or guessing by coordinates.

Read the smallest version-matched CLI guide only when the task is specialized, you are planning rather than operating, or a command/hint does not answer the question. This single read also replaces a separate `agent-device --version` check:

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

When target-specific help says capture or selectors are unsupported, use its control-only loop and the device display as visual truth. Let help own advanced command shapes and platform limits; use `help workflow` as the fallback reference when the compact loop is insufficient.

For precise location workflows, read the installed `settings` help before planning so coordinate support and platform limits come from the active CLI version.
