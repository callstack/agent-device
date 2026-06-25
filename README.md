<a href="https://www.callstack.com/open-source?utm_campaign=generic&utm_source=github&utm_medium=referral&utm_content=agent-device" align="center">
  <picture>
    <img alt="agent-device: device automation CLI for AI agents" src="website/docs/public/agent-device-banner.jpg">
  </picture>
</a>

---

# agent-device

[![npm version](https://img.shields.io/npm/v/agent-device.svg)](https://www.npmjs.com/package/agent-device)
[![CI](https://github.com/callstack/agent-device/actions/workflows/ci.yml/badge.svg)](https://github.com/callstack/agent-device/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-black.svg)](LICENSE)
[![Glama MCP server](https://glama.ai/mcp/servers/callstack/agent-device/badges/score.svg)](https://glama.ai/mcp/servers/callstack/agent-device)

Mobile app verification for AI agents.

A device automation CLI for real apps on iOS, Android, TV, web, and desktop. Agents get token-efficient snapshots, semantic refs, and evidence captured only when needed.

`agent-device` lets coding agents open apps, inspect the current UI, interact with visible elements, and collect debugging evidence through one CLI. Use it when an agent needs to verify what actually happens on a device, not just reason about code.

The CLI is the agent's hands, eyes, and evidence collector; it is not the brain. Your coding agent or QA harness reads the task, interprets the current screen, chooses the next command, and decides whether the result satisfies the test. `agent-device` keeps that loop grounded in structured accessibility data, deterministic actions, and files an engineer can inspect.

If you know Vercel's [agent-browser](https://github.com/vercel-labs/agent-browser), `agent-device` is the same idea for mobile, TV, and desktop apps. Minimal `--platform web` support reuses `agent-browser` when a browser session needs to fit into the same command/session/replay loop.

It works with native iOS and Android apps, plus apps built with Expo, Flutter, and React Native, as long as the target can run on a supported device, simulator, emulator, or desktop environment.

![agent-device demo showing Codex using agent-device to create a new contact in the iOS Contacts app from a simple prompt](./website/docs/public/agent-device-contacts.gif)

## Capabilities

- **Inspect** real app UI through structured accessibility snapshots, interactive refs like `@e3`, selectors, and React Native component trees.
- **Interact** by opening apps, tapping, typing, scrolling, performing gestures, waiting, asserting state, handling alerts, and closing sessions.
- **Capture evidence** with screenshots, videos, logs, traces, network traffic, performance samples, crash context, and React profiles.
- **Replay workflows** by recording `.ad` scripts for local runs, CI, repeatable e2e checks, and strict Maestro YAML export when a flow needs to run in Maestro.
- **Run across platforms** with iOS Simulator automation, Android Emulator automation, physical devices, tvOS, Android TV, macOS, Linux, and desktop app automation, so agents can see and feel the app they work on.

## Use Cases

- Verify mobile changes on real devices, simulators, and emulators before review or merge.
- Give AI coding agents a real app feedback loop while they implement features.
- Debug regressions with screenshots, logs, traces, network evidence, and crash context.
- Profile performance issues with CPU/memory samples and React render profiles when needed.
- Turn exploratory app interactions into replayable e2e checks for CI.
- Use one agent workflow across native iOS, Android, Expo, Flutter, React Native, TV, and desktop apps.

![Sketch showing agent-device as the live app verification layer in the agentic development loop](./website/docs/public/agentic-development-loop.svg)

## Quick Start

Install the CLI:

```bash
npm install -g agent-device@latest
agent-device --version
agent-device help workflow
```

The installed CLI help is the source of truth for agents. Start with `agent-device help workflow`, then follow the topic-specific help when a task needs dogfooding, debugging, replay, or React Native profiling.

Prerequisites depend on the target platform: Node.js 22+, Xcode for iOS/tvOS/macOS targets, Android SDK + ADB for Android, and macOS Accessibility permission for desktop automation. Web automation requires Node 24+. See [Installation](https://oss.callstack.com/agent-device/docs/installation) for platform setup.

Try the basic loop:

```bash
# Find an app.
agent-device apps --platform ios
agent-device apps --platform android

# Start a session.
agent-device open SampleApp --platform ios

# Inspect the current screen. -i returns interactive elements only.
agent-device snapshot -i
# @e1 [heading] "Settings"
# @e2 [button] "Sign In"
# @e3 [text-field] "Email"

# Act, capture evidence, and close.
agent-device fill @e3 "test@example.com"
agent-device screenshot ./artifacts/settings.png
agent-device close
```

Snapshots assign refs like `@e1`, `@e2`, and `@e3` to elements on the current screen. Refs from the latest snapshot are immediately actionable; after scrolling or changing screens, take a fresh snapshot.

Snapshots come from the app's accessibility tree, so high-quality labels, roles, and test IDs make agent runs far more reliable. Use screenshots and videos as evidence or visual fallback, but prefer refs and selectors for actions and assertions whenever the UI exposes enough structure.

## Next Steps

- **Set up your agent**: run the CLI from Cursor, Codex, Claude Code, Windsurf, or another agent terminal. For skills, rules, direct MCP tools, and client-specific setup, see [AI Agent Setup](https://oss.callstack.com/agent-device/docs/agent-setup).
- **Try the sample app**: clone the repo and run the bundled Expo fixture when you want a guided first dogfood run with screenshots, replay, and performance evidence. See [Quick Start](https://oss.callstack.com/agent-device/docs/quick-start).
- **Go deeper**: use [Commands](https://oss.callstack.com/agent-device/docs/commands), [Replay & E2E](https://oss.callstack.com/agent-device/docs/replay-e2e), and [Debugging & Profiling](https://oss.callstack.com/agent-device/docs/debugging-profiling) for production workflows.

## Articles & Videos

### Articles

- [Build an AI QA agent for Expo apps with EAS Workflows](https://expo.dev/blog/build-an-ai-qa-agent-for-expo-apps-with-eas-workflows-in-minutes-today)
- [Agent Device: iOS & Android automation for AI agents](https://www.callstack.com/blog/agent-device-ai-native-mobile-automation-for-ios-android)
- [Building mobile QA agents with Vercel Eve](https://www.callstack.com/blog/building-reviewable-mobile-qa-agents-with-vercel-eve)
- [How we optimized Agent Device for mobile app automation](https://www.callstack.com/blog/how-we-optimized-agent-device-for-mobile-app-automation)

### Videos

- [Verifying mobile apps with agent-device](https://youtu.be/kZDU-k5r9kE)
- [Using agent-device in an AI coding workflow](https://youtu.be/dfVG_aNPkW4)

## Where To Run agent-device

| Path | Best for | Start with |
| --- | --- | --- |
| Local | Exploration, debugging, and development loops on simulators, emulators, physical devices, macOS apps, and Linux desktop targets. | Follow the Quick Start. |
| CI/CD | Automated PR and merge validation with replay scripts and captured artifacts. | Try the [EAS workflow template](https://github.com/callstackincubator/eas-agent-device/blob/main/.eas/workflows/agent-qa-mobile.yml). GitHub Actions template coming soon. |
| Cloud / remote execution | Linux runners, managed devices, and remote execution. | Use [Agent Device Cloud](https://agent-device.dev/cloud), see [Commands](https://oss.callstack.com/agent-device/docs/commands) for remote profiles, or [contact Callstack](mailto:hello@callstack.com) for team-scale QA. |

## How It Works

`agent-device` runs session-aware commands through platform backends: XCTest for iOS and tvOS, ADB plus the Android snapshot helper for Android, a local helper for macOS desktop automation, and AT-SPI for Linux desktop targets.

Node consumers can use the typed client and public subpaths for bridge integrations. `agent-device/android-adb` exposes the Android ADB provider contract, logcat/clipboard/keyboard/app helpers, and port reverse management.

## FAQ

### What is agent-device?

`agent-device` is a device automation CLI for AI mobile app testing. It lets AI agents verify real apps on iOS, Android, TV, desktop, simulators, emulators, and physical devices.

### Does it work with React Native, Expo, Flutter, and native apps?

Yes. `agent-device` works with native iOS and Android apps, Expo apps, Flutter apps, React Native apps, TV apps, and desktop apps that run on supported targets.

### How is it different from Appium, Detox, or Maestro?

Appium, Detox, and Maestro are traditional mobile automation frameworks. `agent-device` is optimized for AI agents that need to inspect app state, interact semantically, capture evidence, debug, profile, and turn useful explorations into replayable checks.

## Used By

Used by teams and developers at Callstack, JPMorgan Chase, Expensify, Shopify, Kindred, Total Wine & More, LegendList, HerLyfe, App & Flow, and more.

## Documentation

- [Docs](https://oss.callstack.com/agent-device/)
- [Agent-readable docs](https://oss.callstack.com/agent-device/llms-full.txt)

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md).

## Made at Callstack

`agent-device` is open source and MIT licensed. Visit [agent-device.dev](https://agent-device.dev/), try the [EAS workflow template](https://github.com/callstackincubator/eas-agent-device/blob/main/.eas/workflows/agent-qa-mobile.yml), read the [docs](https://oss.callstack.com/agent-device/), or contact us at hello@callstack.com.
