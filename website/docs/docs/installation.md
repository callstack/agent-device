---
title: Installation
description: Install agent-device for AI agent app automation, mobile testing, simulator and emulator workflows, desktop app verification, and version-matched CLI help.
---

# Installation

Install `agent-device` on the machine where your coding agent runs terminal commands.

## Requirements

- Node.js 22.12 or newer
- Node.js 24 or newer for web automation. Web commands fail on older Node.js versions, so check
  `node --version` in the shell that runs `agent-device web setup` and `agent-device doctor`
  before you trust a web result.
- Xcode for iOS simulator and device automation (`simctl` and `devicectl`). `agent-device` uses
  the Xcode in `DEVELOPER_DIR`, otherwise the one from `xcode-select -p`. A `DEVELOPER_DIR`
  exported in the shell where you run `agent-device` applies to that command, even when a local
  daemon is already running; without it, the daemon uses the environment it started in. Set
  `DEVELOPER_DIR=""` to use the daemon host's `xcode-select` selection instead.
- Android SDK and ADB for Android
- HarmonyOS Command Line Tools for HarmonyOS (`hdc` available through `HDC_SDK_PATH`, `DEVECO_SDK_HOME`, or `HARMONYOS_COMMAND_LINE_TOOLS`)
- Amazon Vega Developer Tools and an SDK-matched Vega Virtual Device for Vega OS TV
- Swift 5.9 or newer (Xcode command-line tools) for macOS desktop targets. `agent-device` builds its local macOS helper on first use

## Global install

```bash
npm install -g agent-device@latest
agent-device doctor
agent-device --version
agent-device help
```

Run `agent-device doctor` yourself after installing to check that local devices, toolchains, and
dev servers are ready before you hand the CLI to an agent.

A global install gives agents a stable `agent-device` command and help topics that match the installed version:

```bash
agent-device help workflow
agent-device help debugging
agent-device help react-devtools
agent-device help cdp
agent-device help tv
```

Some agent clients run commands with a different `PATH` than your normal shell. If the agent terminal can't find `agent-device` after a global install, run `command -v agent-device` in your own terminal and give the agent that absolute path. If the command lives under a version manager or package-manager global bin directory, check your shell startup files for how it gets on `PATH`.

For Cursor, Codex, Claude Code, Windsurf, Cline, Goose, skills, and project rules, see [AI Agent Setup](/docs/agent-setup). For the first app automation commands, see [Quick Start](/docs/quick-start).

## Update the CLI

Interactive CLI runs periodically check npm for a newer `agent-device` release in the background. When one is available, the CLI suggests reinstalling globally:

```bash
npm install -g agent-device@latest
agent-device doctor
agent-device --version
```

Set `AGENT_DEVICE_NO_UPDATE_NOTIFIER=1` to disable the notice.

## Agent clients and MCP

The `agent-device mcp` server exposes installed `agent-device` commands as structured MCP tools. MCP tools run through the same daemon as the CLI.

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

One-off `npx` use is fine for you and for scripts that intentionally fetch from npm. For agents, use a global install, a project-local install, or a version pinned by you or your project config, so repeated commands resolve to a known CLI. Don't let agents choose a version or run `npx -y agent-device@latest` unless you've decided to trust whatever npm serves.

## Vega OS TV prerequisites

Install the Amazon Vega Developer Tools and a matching Vega SDK and Vega Virtual Device (VVD) with Amazon's installer, then load its environment and verify the tools:

```bash
source ~/vega/env
vega --version
vega doctor
vega device list
```

- Start and stop the local emulator with `vega virtual-device start` and `vega virtual-device stop`; `agent-device` does not boot it implicitly.
- Vega OS support covers the VVD only. `agent-device` does not discover or control physical Fire TV devices.
- List the VVD with `agent-device devices --platform vega --target tv`, then select it explicitly with `--serial VirtualDevice`.
- Appium is optional. You don't need it for device discovery, app lifecycle, or remote-button control.

## macOS desktop notes

- macOS desktop automation uses a local `agent-device-macos-helper` for permission checks (`settings permission ...`), alert handling, and the `frontmost-app`, `desktop`, and `menubar` snapshot surfaces.
- `agent-device` builds the helper on first use and after updates, and caches it under `~/.agent-device/macos-helper/current/`.
- To use your own helper build, set `AGENT_DEVICE_MACOS_HELPER_BIN` to its absolute executable path.

## iOS physical device prerequisites

- The device is paired and listed by `xcrun devicectl list devices`.
- Developer Mode is on in the device's Settings.
- Signing is configured in Xcode (Automatic Signing recommended), or through these environment variables:
  - `AGENT_DEVICE_IOS_TEAM_ID`
  - `AGENT_DEVICE_IOS_SIGNING_IDENTITY`
  - `AGENT_DEVICE_IOS_PROVISIONING_PROFILE`
  - `AGENT_DEVICE_IOS_BUNDLE_ID` (optional base bundle ID for the runner app)
- Free Apple Developer (Personal Team) accounts can fail with "bundle identifier is not available" for generic IDs. Set `AGENT_DEVICE_IOS_BUNDLE_ID` to a unique reverse-DNS value (for example `com.yourname.agentdevice.runner`).
- When the runner fails to start, `error.details.reason` is one of `signing_no_development_team`, `signing_provisioning_profile_missing`, `bundle_identifier_already_registered`, `signing_unspecified`, `devtools_security_developer_mode_disabled` (the Mac's `DevToolsSecurity` setting, which says nothing about the device's Developer Mode toggle), `device_developer_mode_disabled`, `device_developer_disk_image_unavailable`, or `build_failed_unclassified` when the cause is unknown. Branch on `details.reason` and follow `hint`; the error code is `COMMAND_FAILED` for every reason.
- The two `device_*` reasons come from the device itself (`xcrun devicectl device info details`), checked before the runner builds. `device_developer_mode_disabled` means the Developer Mode toggle in Settings is off; turn it on. `device_developer_disk_image_unavailable` means Developer Mode is on but the developer disk image isn't available yet, usually because device support is still installing; wait and retry.
- If device setup is slow, keep the device connected, retry, and check the daemon diagnostics.

## Troubleshoot daemon startup and upgrades

If the daemon fails to start, retry with `--debug` and check the state directory and diagnostics. `agent-device session state-dir` prints the resolved directory without starting a daemon.

Before you upgrade from a version that predates the current daemon lock format, stop every older client and daemon that uses the state directory, using their original CLI. Don't let older versions restart while the upgraded version runs. To run several versions at once, give each its own environment and state directory.

If you ran a source checkout from before state directories were per worktree, stop its daemon in `~/.agent-device` from that older checkout:

```sh
AGENT_DEVICE_STATE_DIR="$HOME/.agent-device" pnpm clean:daemon
```

An upgraded checkout uses a different default directory, so a plain `pnpm clean:daemon` there doesn't reach the old daemon.

The daemon refuses to start when it finds a legacy lock file or can't verify who owns the state directory. Before you recover manually, confirm that every client and daemon using the directory has stopped. Deleting `daemon.json` or `daemon.lock` alone is not a safe reset.

Packaged installs use `~/.agent-device` by default; source checkouts use a per-worktree directory under `~/.agent-device/dev/`. Set `AGENT_DEVICE_STATE_DIR` or pass `--state-dir` to override either default.

In a source checkout, `pnpm clean:daemon --prune-dev` first stops the current checkout's daemon, even if its state directory was used recently. It then finds development state directories with no activity for 14 days (by the newest modification time of the directory and its immediate children) and removes daemon registrations it can confirm are abandoned. It keeps the directories, session artifacts, and logs.
