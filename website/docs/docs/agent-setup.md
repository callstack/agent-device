---
title: AI Agent Setup
description: Configure Cursor, Codex, Claude Code, Windsurf, Cline, Goose, skills, and MCP for agent-device mobile, TV, desktop, and web app verification.
---

# AI Agent Setup

`agent-device` is built for AI agents, but humans usually install it, grant device permissions, and decide which agent client should use it.

Use this page to wire Cursor, Codex, Claude Code, Windsurf, Cline, Goose, or another coding agent into mobile, TV, desktop, and web app verification. It covers skills, project rules, and MCP setup for React Native QA, Expo app verification, iOS Simulator automation, Android Emulator automation, tvOS checks, Android TV checks, web browser sessions, debugging, profiling, and exploratory QA.

The short version: install the CLI, make the agent read version-matched help, and let the agent use either MCP tools or CLI commands. MCP tools use command contracts backed by the same `AgentDeviceClient` execution path as the CLI adapters.

## Prerequisite: install the CLI

```bash
npm install -g agent-device@latest
agent-device --version
agent-device help workflow
```

For one-off human use without a global install:

```bash
npx agent-device --version
npx agent-device help workflow
```

Global install is better for normal agent workflows because repeated commands, skills, and terminal sessions resolve to one stable version. Project-local installs are also good when you want a lockfile-pinned agent-device version.

Avoid telling agents to choose an npm version or run `npx -y agent-device@latest` autonomously: it fetches and executes a mutable npm package without a human prompt. For unattended agent use, prefer a trusted installed binary, a project-local install, or a version supplied by the user or project config.

For Node, Xcode, Android SDK, macOS, and iOS device prerequisites, see [Installation](/docs/installation).

## Install the skill

Install the skill when your agent runtime supports skills:

```bash
npx skills add callstack/agent-device
```

The bundled [agent-device skill](https://github.com/callstack/agent-device/blob/main/skills/agent-device/SKILL.md) is the canonical router for skill-aware clients. It intentionally points agents back to installed CLI help instead of duplicating the command manual.

## Recommended agent rule

Add this as a project rule, custom instruction, or skill equivalent when your agent client supports it:

```text
Use agent-device only for app/device automation tasks. Before planning commands, run `agent-device --version` and read `agent-device help workflow`. For exploratory QA, read `agent-device help dogfood`. For logs, network, traces, or runtime failures, read `agent-device help debugging`. For React Native component trees, props/state/hooks, slow renders, or rerenders, read `agent-device help react-devtools`. For React Native JavaScript heap growth, heap snapshots, or retained-object leaks, read `agent-device help cdp`. For React Native apps, overlays, Metro/Fast Refresh blockers, and routing to React DevTools or debugging evidence, read `agent-device help react-native`.

Use MCP tools or the CLI in the integrated terminal. If `agent-device` is not on PATH but the user installed it globally in another shell, resolve the command the same way the user would from a normal terminal session and run that absolute path instead. This may require inspecting shell startup behavior or package-manager/global bin locations; do not assume the agent process `PATH` is the user's `PATH`. Do not silently fall back to `npx -y agent-device@latest`; ask or use an exact version. MCP exposes structured tools backed by the agent-device client; it does not expose generic shell execution. Prefer `open -> snapshot -i -> act -> re-snapshot -> verify -> close`. Use current refs such as `@e3` for exploration and selectors for durable replay. Keep mutating commands against one session serial. Capture screenshots, logs, network, perf, traces, recordings, and `.ad` replay scripts only when they add evidence.
```

## MCP server

`agent-device mcp` starts the official stdio MCP server. It exposes direct structured tools for installed CLI commands. Tools run through command contracts and `AgentDeviceClient`; local-only workflows stay CLI-only rather than subprocess fallbacks.

For web automation, MCP tools can target `platform: "web"` after the managed backend is available, but `agent-device web setup` and `agent-device web doctor` are CLI-only. Run setup from a terminal in the same effective state directory before asking an MCP client to drive a browser session.

Tool execution failures are returned as MCP tool results with `isError: true`; clients and agents should inspect the tool result, not only the successful JSON-RPC envelope.

MCP clients must not use this server as a generic shell runner. If the CLI is missing, agents should ask a human before installing or updating packages, then verify with `agent-device --version` and start with `agent-device help workflow`.

Global install configuration:

```json
{
  "mcpServers": {
    "agent-device": {
      "command": "agent-device",
      "args": ["mcp"]
    }
  }
}
```

No global install variant. Pin a user- or project-selected package version for unattended agent use:

```json
{
  "mcpServers": {
    "agent-device": {
      "command": "npx",
      "args": ["-y", "agent-device@<reviewed-version>", "mcp"]
    }
  }
}
```

Registry metadata uses MCP name `io.github.callstackincubator/agent-device`, npm package `agent-device`, stdio transport, `mcpName` package verification, `server.json`, `glama.json`, and `smithery.yaml`. Glama lists the server at [callstack/agent-device](https://glama.ai/mcp/servers/callstack/agent-device).

## Cursor

Cursor works well with either the plain CLI or MCP tools. Use the CLI path when you want the most auditable setup and terminal-visible commands. Add MCP when you want Cursor Agent to discover structured `agent-device` tools directly from chat.

### Cursor path A: CLI only

Create a project rule:

```bash
mkdir -p .cursor/rules
cat > .cursor/rules/agent-device.mdc <<'EOF'
---
description: Use agent-device for app and device automation
alwaysApply: true
---

Use agent-device only for app/device automation tasks.
Before planning device work, run `agent-device --version` and read `agent-device help workflow`.
For exploratory QA, read `agent-device help dogfood`.
For logs, network, traces, or runtime failures, read `agent-device help debugging`.
For React Native component trees, props/state/hooks, slow renders, or rerenders, read `agent-device help react-devtools`.
For React Native JavaScript heap growth, heap snapshots, or retained-object leaks, read `agent-device help cdp`.
For React Native apps, overlays, Metro/Fast Refresh blockers, and routing to React DevTools or debugging evidence, read `agent-device help react-native`.

Use the CLI in Cursor's integrated terminal.
If `agent-device` is not on PATH but the user installed it globally in another shell, resolve the absolute binary path instead of using `npx -y agent-device@latest`.
Prefer `open -> snapshot -i -> act -> re-snapshot -> verify -> close`.
Keep mutating commands against one session serial.
EOF
```

Then ask Cursor Agent to run:

```bash
agent-device --version
agent-device help workflow
agent-device apps --platform ios
agent-device open <app-or-url> --platform ios
agent-device snapshot -i
```

### Cursor path B: MCP tools

Create project MCP config:

```bash
mkdir -p .cursor
cat > .cursor/mcp.json <<'JSON'
{
  "mcpServers": {
    "agent-device": {
      "command": "agent-device",
      "args": ["mcp"]
    }
  }
}
JSON
```

Restart Cursor or reconnect MCP from Cursor settings, then ask Cursor Agent:

```text
Use the agent-device MCP tools to inspect the iOS app. Open the app, take an interactive snapshot, act on visible refs/selectors, verify with another snapshot, and close the session.
```

If the MCP server fails because Cursor cannot find the global binary, use the absolute binary path in `.cursor/mcp.json`:

```json
{
  "mcpServers": {
    "agent-device": {
      "command": "/absolute/path/to/agent-device",
      "args": ["mcp"]
    }
  }
}
```

## Codex

Put the recommended rule in `AGENTS.md` or the project instructions. Let Codex run `agent-device` in the terminal:

```bash
agent-device help workflow
agent-device boot --platform ios
agent-device open <app-or-url> --platform ios
agent-device snapshot -i
```

Some agent clients run commands in an environment that differs from the user's normal install shell. If the user installed `agent-device` globally but the agent cannot find it, resolve the command the same way the user would from a normal terminal session, then use the absolute binary path for `--version`, `help workflow`, and subsequent commands. This may require inspecting shell startup behavior or package-manager/global bin locations; do not assume the agent process `PATH` is the user's `PATH`.

For reviews or planning-only tasks, tell the agent not to run devices unless explicitly requested.

## Claude Code

Claude Code works through the terminal CLI and through the VS Code extension panel. The VS Code extension can use MCP servers configured by the Claude CLI and managed with `/mcp`.

### Claude path A: CLI only

Put this in `CLAUDE.md`:

```bash
cat > CLAUDE.md <<'EOF'
# agent-device

Use agent-device only for app/device automation tasks.
Before planning device work, run `agent-device --version` and read `agent-device help workflow`.
For exploratory QA, read `agent-device help dogfood`.
For logs, network, traces, or runtime failures, read `agent-device help debugging`.
For React Native component trees, props/state/hooks, slow renders, or rerenders, read `agent-device help react-devtools`.
For React Native JavaScript heap growth, heap snapshots, or retained-object leaks, read `agent-device help cdp`.
For React Native apps, overlays, Metro/Fast Refresh blockers, and routing to React DevTools or debugging evidence, read `agent-device help react-native`.

Use the CLI in the integrated terminal.
If `agent-device` is not on PATH but the user installed it globally in another shell, resolve the absolute binary path instead of using `npx -y agent-device@latest`.
Prefer `open -> snapshot -i -> act -> re-snapshot -> verify -> close`.
Keep mutating commands against one session serial.
EOF
```

Then ask Claude Code to run:

```bash
agent-device --version
agent-device help workflow
agent-device help dogfood
agent-device help react-native
```

### Claude path B: MCP tools

Add a user-scoped server:

```bash
claude mcp add --transport stdio --scope user agent-device -- agent-device mcp
claude mcp list
```

Or add it to the current project so teammates can review the generated `.mcp.json`:

```bash
claude mcp add --transport stdio --scope project agent-device -- agent-device mcp
```

In Claude Code or the VS Code extension, run:

```text
/mcp
```

Confirm `agent-device` is connected, then ask:

```text
Use the agent-device MCP tools to verify the app. Open the app, take an interactive snapshot, use refs/selectors for actions, verify with another snapshot, and close the session.
```

If Claude cannot start the MCP server because the extension process cannot find the global binary, remove and re-add it with an absolute path:

```bash
claude mcp remove agent-device
claude mcp add --transport stdio --scope user agent-device -- /absolute/path/to/agent-device mcp
```

The same CLI commands remain available in the integrated terminal for long-running or manual workflows.

## Windsurf, Cline, Goose, and other MCP clients

Use the [MCP server](#mcp-server) configuration when the client supports `mcpServers`, then tell the agent to use MCP tools or terminal CLI commands for device workflows.

If the client has project rules or custom instructions, add the recommended agent rule above. If it does not, start the conversation by asking the agent to run `agent-device help workflow` before planning.

## Why this setup works

The CLI stays the auditable automation surface, installed help stays version-matched with the commands, skills and rules route agents toward the right help topics, and MCP gives compatible clients direct structured tools backed by the same daemon/client implementation.

For the broader positioning, supported targets, observability features, and how `agent-device` differs from scripted test frameworks, see [Introduction](/docs/introduction). For exact command groups and platform behavior, see [Commands](/docs/commands).

For the local execution model, permissions, artifacts, and sensitive data guidance, see [Security & Trust](/docs/security-trust).

## Agent-readable docs

Use [llms-full.txt](https://oss.callstack.com/agent-device/llms-full.txt) when an agent needs a single text bundle of the current docs. The installed CLI remains authoritative for exact command syntax:

```bash
agent-device help
agent-device help workflow
agent-device help dogfood
```
