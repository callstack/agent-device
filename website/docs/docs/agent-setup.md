---
title: AI Agent Setup
description: Configure Cursor, Codex, Claude Code, Windsurf, Cline, Goose, iOS Simulator and Android Emulator skills, and MCP for agent-device app verification.
---

# AI Agent Setup

Set up Cursor, Codex, Claude Code, Windsurf, Cline, Goose, or another coding agent to drive mobile, TV, desktop, and web apps with `agent-device`, through skills, project rules, or MCP.

In short: install the CLI, let the agent start with the requested app, and have it read the installed CLI help only for specialized work or when a command is unclear. MCP tools use the same daemon client as the CLI.

## Install the CLI

```bash
npm install -g agent-device@latest
```

Use a global or project-local install so every agent command runs the same version. For Node, Xcode, Android SDK, macOS, and iOS device prerequisites, and for when one-off `npx` use is safe, see [Installation](/docs/installation).

## Install the skills

If your agent client supports skills, install them after the CLI:

```bash
npx skills add callstack/agent-device
```

Skills come from the GitHub repository, not the npm package. The [agent-device skill](https://github.com/callstack/agent-device/blob/main/skills/agent-device/SKILL.md) is the main entry point. For simulator-only work, use the [iOS Simulator skill](https://github.com/callstack/agent-device/blob/main/skills/ios-simulator/SKILL.md) or [Android Emulator skill](https://github.com/callstack/agent-device/blob/main/skills/android-emulator/SKILL.md). Skills tell the agent to start work directly and to read the installed CLI help only when the task is specialized or a command is unclear. Because the help ships with the CLI, it always matches your installed version.

## Recommended agent rule

Add this as a project rule or custom instruction if your agent client supports one:

```text
Use agent-device only for app/device automation tasks. For a normal app-driving task, start immediately. Do not probe first with `--help`, `--version`, `devices`, `appstate`, `snapshot`, or `screenshot`; open the requested app in the foreground and continue from its initial interactive snapshot. For TV, Fire TV, or Vega OS tasks, read `agent-device help tv`. For exploratory QA, read `agent-device help dogfood`. For logs, network, audio, traces, or runtime failures, read `agent-device help debugging`. For React Native component trees, props/state/hooks, slow renders, or rerenders, read `agent-device help react-devtools`. For React Native JavaScript heap growth, heap snapshots, allocation hotspots, or retained-object leaks, read `agent-device help cdp`. For React Native apps, overlays, Metro/Fast Refresh blockers, and routing to React DevTools or debugging evidence, read `agent-device help react-native`.

Use MCP tools or the CLI in the integrated terminal. If `agent-device` is not on PATH but the user installed it globally in another shell, resolve the command the same way the user would from a normal terminal session and run that absolute path instead. This may require inspecting shell startup behavior or package-manager/global bin locations; do not assume the agent process `PATH` is the user's `PATH`. Do not silently fall back to `npx -y agent-device@latest`; ask or use an exact version. MCP exposes structured tools backed by the agent-device client; it does not expose generic shell execution. Prefer `open -> snapshot -i -> act -> re-snapshot -> verify -> close` where the target supports capture and selectors; otherwise follow target-specific help. Use current refs such as `@e3` for exploration and selectors for durable replay. Keep mutating commands against one session serial. Capture screenshots, logs, network, audio, perf, traces, recordings, and `.ad` replay scripts only when they add evidence.
```

## MCP server

`agent-device mcp` starts the stdio MCP server. It exposes installed CLI commands as structured tools. Some local workflows are CLI-only and have no MCP tool.

For web automation, MCP tools can target `platform: "web"` once the managed browser backend is set up, but `agent-device web setup` and `agent-device web doctor` are CLI-only. Run setup from a terminal that uses the same state directory as the MCP server before you ask an MCP client to drive a browser session.

MCP-only clients don't need a separately installed skill. When a client connects (`initialize` and `server/discover`), the server returns short `instructions` with the core workflow: start with `open`, act with `settle: true`, verify, `close`, how to keep refs accurate, and how to recover when the accessibility tree is sparse. An MCP-only `help` tool returns the same guides as `agent-device help <topic|command>`. Agents don't call `help` at startup; they call it for specialized work (gestures, scripting, TV, macOS, web, remote, debugging) or when a command is unclear.

When a tool fails, the server returns an MCP tool result with `isError: true`. Check the tool result, not only whether the JSON-RPC call succeeded.

The server does not run arbitrary shell commands. If the CLI is missing, the agent should ask you before installing or updating packages, reconnect the server after setup, and retry the original app-driving command without adding version or help probes.

Configuration for a global install:

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

Without a global install, pin a version you've reviewed for unattended agent use:

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

In MCP registries, the server is listed as `io.github.callstack/agent-device` (npm package `agent-device`, stdio transport). Glama lists it at [callstack/agent-device](https://glama.ai/mcp/servers/callstack/agent-device).

## Fix a missing agent-device command

Some agent clients run commands with a different `PATH` than your normal shell, so a global install that works in your terminal can be missing in the agent's terminal or MCP server. Run `command -v agent-device` in your own terminal and give the agent that absolute path, or use it as the MCP server `command`. If the path is under a version manager or a package-manager global bin directory, check your shell startup files for how that directory gets on `PATH`; the agent client may not load them.

## Cursor

Cursor can use the CLI or MCP tools. Use the CLI when you want every command visible in the terminal. Add MCP when you want Cursor Agent to discover `agent-device` tools directly from chat.

### Cursor: use the CLI

Create a project rule:

```bash
mkdir -p .cursor/rules
cat > .cursor/rules/agent-device.mdc <<'EOF'
---
description: Use agent-device for app and device automation
alwaysApply: true
---

Use agent-device only for app/device automation tasks.
For a normal app-driving task, start immediately. Do not probe first with `--help`, `--version`, `devices`, `appstate`, `snapshot`, or `screenshot`; open the requested app in the foreground and continue from its initial interactive snapshot.
For TV, Fire TV, or Vega OS tasks, read `agent-device help tv`.
For exploratory QA, read `agent-device help dogfood`.
For logs, network, audio, traces, or runtime failures, read `agent-device help debugging`.
For React Native component trees, props/state/hooks, slow renders, or rerenders, read `agent-device help react-devtools`.
For React Native JavaScript heap growth, heap snapshots, or retained-object leaks, read `agent-device help cdp`.
For React Native apps, overlays, Metro/Fast Refresh blockers, and routing to React DevTools or debugging evidence, read `agent-device help react-native`.

Use the CLI in Cursor's integrated terminal.
If `agent-device` is not on PATH but the user installed it globally in another shell, resolve the absolute binary path instead of using `npx -y agent-device@latest`.
Prefer `open -> snapshot -i -> act -> re-snapshot -> verify -> close` where supported; otherwise follow target-specific help.
Keep mutating commands against one session serial.
EOF
```

Then ask Cursor Agent to run:

```bash
agent-device open <app-or-url> --platform ios --foreground
```

### Cursor: use MCP tools

Create a project MCP config:

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

Restart Cursor or reconnect MCP in Cursor settings, then ask Cursor Agent:

```text
Use the agent-device MCP tools to inspect the iOS app. Open the app, take an interactive snapshot, act on visible refs/selectors, verify with another snapshot, and close the session.
```

If the MCP server fails to start because Cursor can't find the global binary, use the absolute binary path in `.cursor/mcp.json`:

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

Put the [recommended rule](#recommended-agent-rule) in `AGENTS.md` or the project instructions, then let Codex run `agent-device` in the terminal:

```bash
agent-device open <app-or-url> --platform ios --foreground
```

If Codex can't find `agent-device`, see [Fix a missing agent-device command](#fix-a-missing-agent-device-command).

For reviews or planning-only tasks, tell the agent not to touch devices unless you ask.

## Claude Code

Claude Code can use `agent-device` from the terminal or from the VS Code extension. The VS Code extension uses MCP servers you add with the `claude` CLI and manage with `/mcp`.

### Claude Code: use the CLI

Put this in `CLAUDE.md`:

```bash
cat > CLAUDE.md <<'EOF'
# agent-device

Use agent-device only for app/device automation tasks.
For a normal app-driving task, start immediately. Do not probe first with `--help`, `--version`, `devices`, `appstate`, `snapshot`, or `screenshot`; open the requested app in the foreground and continue from its initial interactive snapshot.
For TV, Fire TV, or Vega OS tasks, read `agent-device help tv`.
For exploratory QA, read `agent-device help dogfood`.
For logs, network, audio, traces, or runtime failures, read `agent-device help debugging`.
For React Native component trees, props/state/hooks, slow renders, or rerenders, read `agent-device help react-devtools`.
For React Native JavaScript heap growth, heap snapshots, or retained-object leaks, read `agent-device help cdp`.
For React Native apps, overlays, Metro/Fast Refresh blockers, and routing to React DevTools or debugging evidence, read `agent-device help react-native`.

Use the CLI in the integrated terminal.
If `agent-device` is not on PATH but the user installed it globally in another shell, resolve the absolute binary path instead of using `npx -y agent-device@latest`.
Prefer `open -> snapshot -i -> act -> re-snapshot -> verify -> close` where supported; otherwise follow target-specific help.
Keep mutating commands against one session serial.
EOF
```

Then ask Claude Code to run:

```bash
agent-device open <app-or-url> --platform android --foreground
```

### Claude Code: use MCP tools

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

If Claude Code can't start the MCP server because the extension can't find the global binary, remove the server and add it again with an absolute path:

```bash
claude mcp remove agent-device
claude mcp add --transport stdio --scope user agent-device -- /absolute/path/to/agent-device mcp
```

You can still run CLI commands in the integrated terminal for long-running or manual workflows.

## Windsurf, Cline, Goose, and other MCP clients

If the client supports `mcpServers`, use the [MCP server](#mcp-server) configuration, then tell the agent to use MCP tools or terminal CLI commands for device work.

If the client supports project rules or custom instructions, add the [recommended agent rule](#recommended-agent-rule). If it doesn't, ask the agent to open the requested app and continue from the initial interactive snapshot; point it to a help topic only when the task is specialized or a command is unclear.

## Related pages

For supported targets, evidence features, and how `agent-device` differs from scripted test frameworks, see [Introduction](/docs/introduction). For command groups and platform behavior, see [Commands](/docs/commands).

For the local execution model, permissions, artifacts, and sensitive data guidance, see [Security & Trust](/docs/security-trust).

## Agent-readable docs

Use [llms-full.txt](https://oss.callstack.com/agent-device/llms-full.txt) when an agent needs the whole documentation as one text file. For exact command syntax, the installed CLI help is authoritative:

```bash
agent-device help
agent-device help workflow
agent-device help dogfood
```
