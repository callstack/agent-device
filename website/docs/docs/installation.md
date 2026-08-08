---
title: Installation
description: Install agent-device for AI agent app automation, mobile testing, simulator and emulator workflows, desktop app verification, and version-matched CLI help.
---

# Installation

Install `agent-device` on the machine where the coding agent will run terminal commands.

## Global install

```bash
npm install -g agent-device@latest
agent-device doctor
agent-device --version
agent-device help
```

Run `agent-device doctor` yourself after installation to check local device,
toolchain, and dev-server readiness before handing the CLI to an agent.

Use global install for normal agent workflows. It gives agents a stable `agent-device` command and version-matched help topics:

```bash
agent-device help workflow
agent-device help debugging
agent-device help react-devtools
agent-device help cdp
agent-device help tv
```

Some agent clients run commands in an environment that differs from the user's normal install shell. If `agent-device` is missing in the agent terminal but was installed globally elsewhere, resolve the command the same way the user would from a normal terminal session, then use the absolute binary path for agent commands. This may require inspecting shell startup behavior or package-manager/global bin locations; do not assume the agent process `PATH` is the user's `PATH`.

For Cursor, Codex, Claude Code, Windsurf, Cline, Goose, skills, and project rules, see [AI Agent Setup](/docs/agent-setup). For the first app automation commands, see [Quick Start](/docs/quick-start).

Interactive CLI runs periodically check for a newer published `agent-device` package in the background. When an upgrade is available, the CLI suggests reinstalling the package globally:

```bash
npm install -g agent-device@latest
agent-device doctor
agent-device --version
```

Set `AGENT_DEVICE_NO_UPDATE_NOTIFIER=1` to disable the notice.

## Agent clients and MCP

The official MCP server exposes direct structured tools for installed `agent-device` commands. Tools use command contracts through `AgentDeviceClient`, so app and device automation still uses the same daemon implementation.

```bash
agent-device mcp
```

Use [AI Agent Setup](/docs/agent-setup#mcp-server) for copy-paste MCP client configuration.

## Without installing

```bash
npx agent-device --version
npx agent-device help workflow
npx agent-device open Settings --platform ios
```

One-off `npx` usage is fine for humans and scripts that intentionally fetch from npm. For agents, prefer a global install, a project-local install, or a version supplied by the user or project config so repeated commands resolve to a known CLI. Do not ask agents to choose a version or run `npx -y agent-device@latest` without an explicit trust decision.

## Requirements

- Node.js 22+
- Xcode for iOS simulator/device automation (`simctl` + `devicectl`)
- Android SDK / ADB for Android
- HarmonyOS Command Line Tools for HarmonyOS (`hdc` available through `HDC_SDK_PATH`, `DEVECO_SDK_HOME`, or `HARMONYOS_COMMAND_LINE_TOOLS`)
- Amazon Vega Developer Tools and an SDK-matched Vega Virtual Device for Vega OS TV
- On macOS desktop targets, Swift 5.9+ / Xcode command-line tools are used to build the local `agent-device-macos-helper` on first use from source checkouts

## Vega OS TV prerequisites

Install the latest Amazon Vega Developer Tools and matching Vega SDK/VVD through Amazon's supported installer, then load its environment and verify the tools:

```bash
source ~/vega/env
vega --version
vega doctor
vega device list
```

- Start and stop the local emulator with `vega virtual-device start` and `vega virtual-device stop`; `agent-device` does not boot it implicitly.
- Initial Vega OS support is VVD-only; physical Fire TV discovery and control are not admitted until hardware evidence is validated.
- Use `agent-device devices --platform vega --target tv`, then select the VVD explicitly with `--serial VirtualDevice`.
- Appium is optional evidence tooling; it is not required for agent-device discovery, app lifecycle, or remote-button control.

## macOS desktop notes

- The macOS desktop path uses a local `agent-device-macos-helper` for permission checks (`settings permission ...`), alert handling, and helper-backed desktop snapshot surfaces (`frontmost-app`, `desktop`, `menubar`).
- Source checkouts build the helper lazily on first use and cache it under `~/.agent-device/macos-helper/current/`.
- Release distribution should ship a stable signed/notarized helper build so macOS trust/TCC state is tied to a durable code signature instead of an ad-hoc local binary.
- Local helper overrides through `AGENT_DEVICE_MACOS_HELPER_BIN` are intended for operators and packaged distributions; the value must be an absolute executable path.

## iOS physical device prerequisites

- Device is paired and visible in `xcrun devicectl list devices`.
- Developer Mode enabled on device.
- Signing configured in Xcode (Automatic Signing recommended), or use:
- `AGENT_DEVICE_IOS_TEAM_ID`
- `AGENT_DEVICE_IOS_SIGNING_IDENTITY`
- `AGENT_DEVICE_IOS_PROVISIONING_PROFILE`
- `AGENT_DEVICE_IOS_BUNDLE_ID` (optional runner bundle-id base override)
- Free Apple Developer (Personal Team) accounts can fail with "bundle identifier is not available" for generic IDs; set `AGENT_DEVICE_IOS_BUNDLE_ID` to a unique reverse-DNS value (for example `com.yourname.agentdevice.runner`).
- If device setup is slow, keep the device connected and inspect daemon diagnostics after retrying.
- If daemon startup reports stale metadata, remove stale files and retry:
  - `<state-dir>/daemon.json`
  - `<state-dir>/daemon.lock`
  - default state dir is `~/.agent-device` for packaged installs; source checkouts default to a worktree-scoped dir under `~/.agent-device/dev/` unless `AGENT_DEVICE_STATE_DIR` or `--state-dir` is set
  - `agent-device session state-dir` prints the resolved state dir without starting the daemon
  - after pulling the worktree-scoped daemon change in a source checkout, stop any legacy default daemon once with `AGENT_DEVICE_STATE_DIR=~/.agent-device pnpm clean:daemon`
  - worktree-scoped state dirs outlive deleted worktrees; `pnpm clean:daemon --prune-dev` removes dirs under `~/.agent-device/dev/` with no live daemon and no activity for 14 days (one line printed per removed dir)
