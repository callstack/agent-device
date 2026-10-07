---
title: Introduction
description: Learn what agent-device is, where it fits in agentic mobile, TV, desktop, and web development, and how agents use it for app verification, debugging, profiling, QA, and replay.
---

# Introduction

`agent-device` is a CLI that lets coding agents verify and QA apps on iOS, Android, HarmonyOS, tvOS, Android TV, Amazon Vega OS TV apps in the Vega Virtual Device, macOS, Linux desktop targets, and a limited managed web browser. Which interactions, structured UI, evidence, performance, and replay features you get depends on what each target supports.

Use it when an agent needs to inspect and operate a running app, not only reason about source code or screenshots.

`agent-device` operates the app and collects evidence. It does not decide what to test: your coding agent, QA agent, or project harness reads the task, interprets the current screen, chooses commands, and judges whether the result meets the scenario. Because decisions stay with the agent, you can mix live exploration, deterministic replay, and human review.

## What you can use it for

- **App verification for agents**: run the app, inspect visible UI, act through refs/selectors, and verify expected state.
- **Token-efficient UI context**: accessibility snapshots give agents structured UI state instead of screenshots alone.
- **Runtime evidence**: capture screenshots, recordings, logs, network traffic, audio-level probes for browser and host-rendered simulator/emulator audio, traces, CPU/memory/perf snapshots, and crash-related logs when the happy path breaks.
- **Replayable checks**: turn stable exploratory sessions into `.ad` replay scripts that run again without AI.
- **React Native and Expo workflows**: pair device automation with optional React DevTools profiling for component trees, props/state/hooks, slow renders, and rerenders.
- **Local devices and app surfaces**: drive simulators, emulators, physical devices, TV targets, desktop apps, and browser sessions through one CLI.

If you know `agent-browser`, `agent-device` brings the same workflow to mobile, TV, desktop, and a limited managed web browser.

## Development loop

With `agent-device`, an agent can write code, run the app, verify the UI end to end, collect screenshots, videos, logs, and performance evidence, and feed bugs, crashes, or performance findings into the next fix before a human reviews the PR.

![Sketch showing agent-device as the live app verification layer in the agentic development loop](/agentic-development-loop.svg)

## How agents use it

A typical session looks like this:

```bash
agent-device apps --platform ios
agent-device open <app-or-url> --platform ios
agent-device snapshot -i
agent-device press @e12
agent-device diff snapshot -i
agent-device close
```

Snapshots come from the accessibility tree: labels, roles, values, and test IDs are what agents use to choose refs and selectors. Screenshots and videos remain useful as evidence and as a fallback when a screen exposes poor accessibility data, but refs and selectors are more reliable than pixel or OCR guesses.

Start with the core workflow guide in the installed CLI help. [Commands](/docs/commands) lists the other help topics, which agents read for specialized work or when a command is unclear:

```bash
agent-device help workflow
```

Use [AI Agent Setup](/docs/agent-setup) for Cursor, Codex, Claude Code, Windsurf, Cline, Goose, skills, and MCP setup. Use [Commands](/docs/commands) for detailed command groups and platform behavior.

## Where it fits

`agent-device` is for agents, but humans still install it, grant permissions, review artifacts, and decide what ships.

It complements scripted test frameworks such as Appium, Maestro, Detox, XCTest, and Espresso. Keep those for stable human-authored coverage. Use `agent-device` when an agent needs to explore, reproduce, debug, profile, collect evidence, or record a replay from live app behavior.

MCP clients can drive devices directly through the `agent-device mcp` server, which exposes the installed commands as structured tools. See [MCP server](/docs/agent-setup#mcp-server).

## Next steps

- Install the CLI: [Installation](/docs/installation)
- Set up an agent client: [AI Agent Setup](/docs/agent-setup)
- Run the first commands: [Quick Start](/docs/quick-start)
- Inspect all command groups: [Commands](/docs/commands)
- Collect runtime evidence: [Debugging & Profiling](/docs/debugging-profiling)
- Record deterministic flows: [Replay & E2E](/docs/replay-e2e)
