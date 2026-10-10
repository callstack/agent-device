# App automation for coding agents on mobile, TV, and desktop.

> agent-device lets coding agents read app UI as structured data, interact with it, and collect evidence across mobile, TV, and desktop targets. Use it to verify generated code, debug broken flows, profile runtime behavior, and turn exploratory QA into replayable checks.

[Get Started](/docs/agent-setup) | [Commands](/docs/commands)

## Features

- **One CLI, many app surfaces**: Control iOS, Android, HarmonyOS, tvOS, Android TV, Amazon Vega OS TV apps in the Vega Virtual Device, macOS, Linux desktop targets, and a limited managed web browser through one CLI.
- **Accessibility-first snapshots**: On supported targets, agents read the accessibility tree instead of reasoning from screenshots alone.
- **Interactions by ref, selector, or finder**: Tap, pan, fling, pinch, rotate, scroll, focus, type, assert, and find visible UI through refs, selectors, and semantic finders.
- **Debugging and profiling**: Collect logs, inspect network traffic, capture screenshots and recordings, and sample performance where the target supports it.
- **Session and replay**: Keep app state across commands in a session, and replay recorded `.ad` scripts to reproduce flows without an AI agent.
- **React Native internals**: Use `agent-device react-devtools` for component trees and render profiles, and `agent-device cdp` for JS heap snapshots, diffs, and leak retainers.
