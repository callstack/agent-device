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

Let your coding agent verify its changes in the running app.

`agent-device` lets coding agents inspect, control, and verify apps on iOS, Android, TV, web, macOS, and Linux. Agents can read token-efficient accessibility snapshots, find elements by ref or selector, run device actions, and save evidence for review.

Your coding agent or QA tool reads each result and chooses the next command. `agent-device` runs the command and saves evidence when asked.

`agent-device` uses the inspect-act-verify process from Vercel's [agent-browser](https://github.com/vercel-labs/agent-browser) for mobile, TV, and desktop apps. Basic `--platform web` support runs `agent-browser` in the same session and replay system.

## Quick start

Install the CLI and check setup. It requires Node.js 22.12 or newer; web automation requires Node.js 24 or newer. See [Installation](https://oss.callstack.com/agent-device/docs/installation) for target requirements.

```bash
npm install -g agent-device@latest
agent-device doctor
agent-device --version
agent-device help workflow
```

Run `agent-device doctor` yourself before handing the CLI to an agent. The installed CLI help defines current behavior. `agent-device help workflow` links to guides for debugging, replay, React Native profiling, and other tasks.

Add a contact in the built-in iOS Contacts app:

```bash
# Start a session.
agent-device open Contacts --platform ios

# Inspect the screen. The example below shows the output; refs vary.
agent-device snapshot -i
# @e2 [button] "Add"

# Use the ref and wait for the UI to settle.
agent-device press @e2 --settle
# The diff includes:
# + @e7 [text-field] "First name"

agent-device fill @e7 "Ada" --settle
# The next diff shows changed values and current refs:
# - @e7 [text-field] "First name"
# + @e14 [text-field] "Ada"
# = @e15 [text-field] "Last name"

# Capture evidence and close the session.
agent-device screenshot ./contact-form.png
agent-device close
```

Use refs only from the latest output. Do not assume an earlier `@eN` still identifies the same element. After a command with `--settle`, use the refs in its diff. Take another snapshot only if the diff omits what you need.

Snapshots use the app's accessibility tree. Clear labels, roles, and test IDs make agent runs more reliable. Use screenshots and videos as evidence or when accessibility data is poor. Use refs and selectors for actions and assertions when you can.

![agent-device demo showing Codex using agent-device to create a new contact in the iOS Contacts app from a simple prompt](./website/docs/public/agent-device-contacts.gif)

## What agents can do

- **Inspect app state** through accessibility snapshots, refs, selectors, and React Native component trees.
- **Act on visible UI** by tapping or pressing elements, filling fields, scrolling, making gestures, waiting, asserting state, and handling alerts.
- **Diagnose failures** with screenshots, video, logs, traces, network data, performance samples, crash details, and React profiles.
- **Repeat workflows** by saving working steps as `.ad` scripts for local use or CI. Export strict Maestro YAML when needed.

See [Commands](https://oss.callstack.com/agent-device/docs/commands) for the commands and evidence each target supports.

![Diagram of the agentic development loop: humans assign tasks, agents write and review code, agent-device verifies mobile apps, pull requests receive evidence, and bugs or performance issues lead to fixes](./website/docs/public/agentic-development-loop.svg)

## Next steps

- **Set up your agent**: run the CLI from Cursor, Codex, Claude Code, Windsurf, or another agent terminal. See [AI Agent Setup](https://oss.callstack.com/agent-device/docs/agent-setup) for skills, rules, MCP tools, and setup for each client.
- **Try the sample app**: clone the repo and run the bundled Expo test app. [Quick Start](https://oss.callstack.com/agent-device/docs/quick-start) covers a guided run with screenshots, replay, and performance data.
- **Build repeatable tests**: use [Replay & E2E](https://oss.callstack.com/agent-device/docs/replay-e2e) to repeat tests. Use [Debugging & Profiling](https://oss.callstack.com/agent-device/docs/debugging-profiling) to find bugs.

## Articles and videos

### Articles

- [Build an AI QA agent for Expo apps with EAS Workflows](https://expo.dev/blog/build-an-ai-qa-agent-for-expo-apps-with-eas-workflows-in-minutes-today)
- [Agent Device: iOS & Android automation for AI agents](https://www.callstack.com/blog/agent-device-ai-native-mobile-automation-for-ios-android)
- [Building mobile QA agents with Vercel Eve](https://www.callstack.com/blog/building-reviewable-mobile-qa-agents-with-vercel-eve)
- [How we optimized Agent Device for mobile app automation](https://www.callstack.com/blog/how-we-optimized-agent-device-for-mobile-app-automation)

### Videos

- [Verifying mobile apps with agent-device](https://youtu.be/kZDU-k5r9kE)
- [Using agent-device in an AI coding workflow](https://youtu.be/dfVG_aNPkW4)
- [Cloud agents that test mobile apps on real devices](https://youtu.be/r5P0detC4bs?is=_KB6SZbLFRB1au_z)

## Where to run agent-device

| Path | Best for | Start with |
| --- | --- | --- |
| Local | Trying commands and debugging apps on simulators, emulators, physical devices, macOS, and Linux. | Follow the Quick Start. |
| CI/CD | Automated pull request and merge validation with replay scripts and captured artifacts. | Try the [EAS workflow template](https://github.com/callstackincubator/eas-agent-device/blob/main/.eas/workflows/agent-qa-mobile.yml). GitHub Actions template coming soon. |
| Cloud / remote | Linux runners, managed devices, and remote jobs. | Use [Agent Device Cloud](https://agent-device.dev/cloud), set a remote profile with [Commands](https://oss.callstack.com/agent-device/docs/commands), or [contact Callstack](mailto:hello@callstack.com) for team QA. |

## How it works

`agent-device` keeps device state in sessions. It sends commands to XCTest on iOS and tvOS, ADB and the snapshot helper on Android, a local helper on macOS, and AT-SPI on Linux.

Node.js apps can use the typed client or public subpaths. `agent-device/android-adb` provides the Android ADB provider interface, helpers for logcat, the clipboard, the keyboard, and apps, and port reverse management.

## FAQ

### What is agent-device?

`agent-device` is a command-line tool that lets coding agents inspect, control, and verify apps and save evidence for review. It supports iOS, Android, TV, web, macOS, and Linux.

### Does it work with React Native, Expo, Flutter, and native apps?

Yes. `agent-device` supports native iOS and Android apps, plus React Native, Expo, and Flutter apps on supported targets. The commands and evidence vary by target.

### How is it different from Appium, Detox, or Maestro?

With `agent-device`, an agent reads app state and chooses each command at run time. Teams use Appium, Detox, and Maestro to write and maintain test suites. `agent-device` can complement them by saving its runs as `.ad` scripts or exporting them as strict Maestro YAML.

### Can agent-device run in CI?

Yes. Record a run as an `.ad` script, replay it locally or in CI, and save screenshots, logs, and other artifacts for review. See [Replay & E2E](https://oss.callstack.com/agent-device/docs/replay-e2e) or start with the [EAS workflow template](https://github.com/callstackincubator/eas-agent-device/blob/main/.eas/workflows/agent-qa-mobile.yml).

## Who uses agent-device?

Teams and developers at Callstack, JPMorgan Chase, [Expensify](https://www.callstack.com/blog/how-expensify-uses-agent-device-for-mobile-bug-evidence-and-profiling), [Shopify](https://x.com/mustafa01ali/status/2036577353178943826), Kindred, [Total Wine & More](https://www.callstack.com/podcasts/how-ai-is-changing-react-native-development-and-testing), [LegendList](https://x.com/jmeistrich/status/2036398735698305178), HerLyfe, App & Flow, and others use `agent-device`.

## Documentation

- [Docs](https://oss.callstack.com/agent-device/)
- [Agent-readable docs](https://oss.callstack.com/agent-device/llms-full.txt)

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md).

## Made at Callstack

`agent-device` is open source under the MIT license. Visit [agent-device.dev](https://agent-device.dev/) or [contact Callstack](mailto:hello@callstack.com).
