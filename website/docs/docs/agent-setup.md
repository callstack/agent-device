---
title: AI agent setup
description: Configure Cursor, Codex, Claude Code, Windsurf, Cline, Goose, iOS Simulator and Android Emulator skills, and MCP for agent-device app verification.
---

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

Add this rule to your agent client's project rules or custom instructions. [Set up your client](#set-up-your-agent-client) shows where the file goes for each client.

```text
Use agent-device only for app/device automation tasks.
For a normal app-driving task, start immediately. Do not probe first with `--help`, `--version`, `devices`, `appstate`, `snapshot`, or `screenshot`; open the requested app in the foreground and continue from its initial interactive snapshot.
For TV, Fire TV, or Vega OS tasks, read `agent-device help tv`.
For exploratory QA, read `agent-device help dogfood`.
For logs, network, audio, traces, or runtime failures, read `agent-device help debugging`.
For React Native component internals (tree, props, state, hooks) and performance profiling (slow renders, rerenders, and their causes), read `agent-device help react-devtools`.
For React Native JavaScript heap growth, heap snapshots, allocation hotspots, or retained-object leaks, read `agent-device help cdp`.
For React Native apps, overlays, Metro/Fast Refresh blockers, and routing to profiling or debugging evidence, read `agent-device help react-native`.

Use MCP tools or the CLI in the integrated terminal.
If `agent-device` is not on PATH but the user installed it globally in another shell, resolve the command the same way the user would from a normal terminal session and run that absolute path instead. This may require inspecting shell startup behavior or package-manager/global bin locations; do not assume the agent process `PATH` is the user's `PATH`.
Do not silently fall back to `npx -y agent-device@latest`; ask or use an exact version.
MCP exposes structured tools backed by the agent-device client; it does not expose generic shell execution.
Prefer `open -> snapshot -i -> act -> re-snapshot -> verify -> close` where the target supports capture and selectors; otherwise follow target-specific help.
Use current refs such as `@e3` for exploration and selectors for durable replay.
Keep mutating commands against one session serial.
Capture screenshots, logs, network, audio, perf, traces, recordings, and `.ad` replay scripts only when they add evidence.
```

## MCP server

`agent-device mcp` starts the stdio MCP server. It exposes installed CLI commands as tools. Some local workflows are CLI-only and have no MCP tool.

Each tool declares a display title and separate read-only and destructive hints. A read-only tool changes no device, app, session, or host state: no device boot, foreground change, or artifact write. Observation and evidence tools that can cause these changes declare a write effect without a destructive hint. This includes `apps` and `appstate`, whose readiness checks can boot a device. Tools that can replace or delete existing data, or dispatch arbitrary app actions, declare a destructive effect; for example, `clipboard` can replace text and `find` can click. These hints help your client present permissions; they do not enforce access controls. Idempotence stays at MCP's default (`idempotentHint: false`).

`agent-device mcp` accepts no flags or arguments other than `--structured`, `--help`, and `--version`; any other argument fails with `INVALID_ARGS`. To configure the server, set `AGENT_DEVICE_*` environment variables or `AGENT_DEVICE_CONFIG` in the client's server entry. For example, set the state directory with `AGENT_DEVICE_STATE_DIR`, and the remote `tenant`, `runId`, and `leaseId` with `AGENT_DEVICE_TENANT`, `AGENT_DEVICE_RUN_ID`, and `AGENT_DEVICE_LEASE_ID` (or the same keys in `~/.agent-device/config.json`). Tool calls cannot pass these values.

For web automation, MCP tools can target `platform: "web"` once the managed browser backend is set up, but `agent-device web setup` and `agent-device web doctor` are CLI-only. Run setup from a terminal that uses the same state directory as the MCP server before you ask an MCP client to drive a browser session.

MCP-only clients don't need a separately installed skill. When a client connects (`initialize` and `server/discover`), the server returns short `instructions` with the core workflow: start with `open`, act with `settle: true`, verify, `close`, how to keep refs accurate, and how to recover when the accessibility tree is sparse. An MCP-only `help` tool returns the same guides as `agent-device help <topic|command>`. Agents don't call `help` at startup; they call it for specialized work (gestures, scripting, TV, macOS, web, remote, debugging) or when a command is unclear.

Tool results are compact text, such as `@e4 [button] "Products"` lines and settled UI diffs. Tools declare no output schema, and results carry no `structuredContent`, because some clients show the model `structuredContent` instead of the text. To get results as JSON text, set `AGENT_DEVICE_RESPONSE_LEVEL` to `digest` or `full`, or set `AGENT_DEVICE_COST=1`, in the server entry. Tool calls cannot pass these values, `debug`, or the `target` alias of `deviceTarget`.

Clients that defer tool schemas, such as Claude Code, load the core loop tools up front: `open`, `snapshot`, `press`, `fill`, `back`, `wait`, and `scroll`; other tools, `screenshot` included, load on first use. Each tool also carries search keywords for the client's tool search. To run a known multi-step walk in one call, use `batch`; its description shows the step shape.

If your client reads results as data, start the server with `agent-device mcp --structured`. Tools that have a typed result, such as `press` or `wait`, then declare an output schema and return `structuredContent` that matches it. Other tools return `structuredContent` when the server is set to return JSON as above. A failed call returns the error in `structuredContent`.

Tools that act on a UI element take its target as top-level arguments, in the same words as the CLI: `press {"ref":"@e12"}`, `click {"selector":"id=\"submit\""}`, or `press {"x":120,"y":340}`. `get` takes `ref` or `selector`.

When a tool fails, the server returns an MCP tool result with `isError: true`. Check the tool result, not only whether the JSON-RPC call succeeded. The error text is short: the error code and typed reason, a one-line message, the cause when known, and the next step. When the failure flushed a diagnostics log, the text includes its path; a message cut short in the summary follows in full. A call with an argument the tool doesn't take fails with `INVALID_ARGS`, and its hint shows a call that the tool accepts.

The server runs one `tools/call` at a time, in the order it receives them. It answers `ping`, `tools/list`, and the handshake at once, even while a long tool call such as `test` or `wait` runs. A `notifications/cancelled` for a running or queued `tools/call` stops it, and the server sends no response for that request. Cancellation stops the daemon request, not work that already reached the device: on iOS, a command the device received keeps running there, and the session waits for it. See [Command methods](/docs/client-api#command-methods). A JSON-RPC batch cannot carry a `tools/call`; the server refuses that element with `-32600`.

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

## Set up your agent client

Each client reads the [recommended agent rule](#recommended-agent-rule) from its own location:

| Client | Where the rule goes | Client-specific wrapper |
| --- | --- | --- |
| Cursor | `.cursor/rules/agent-device.mdc` | Required `.mdc` frontmatter above the rule |
| Codex | `AGENTS.md` in the project root | None |
| Claude Code | `CLAUDE.md` in the project root | None; an `# agent-device` heading keeps it separate from other instructions |
| Windsurf, Cline, Goose, and others | The client's project rules or custom instructions | Whatever the client requires for a rules file |

The sections below cover each client, including MCP setup.

## Cursor

Cursor can use the CLI or MCP tools. Use the CLI when you want every command visible in the terminal. Add MCP when you want Cursor Agent to discover `agent-device` tools directly from chat.

### Cursor: use the CLI

Create the rule file with the frontmatter Cursor requires:

```bash
mkdir -p .cursor/rules
cat > .cursor/rules/agent-device.mdc <<'EOF'
---
description: Use agent-device for app and device automation
alwaysApply: true
---

REPLACE THIS LINE with the recommended agent rule from https://agent-device.dev/docs/agent-setup#recommended-agent-rule
EOF
```

Open `.cursor/rules/agent-device.mdc` and replace the placeholder line with the [recommended agent rule](#recommended-agent-rule). Then ask Cursor Agent to run:

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

Paste the [recommended agent rule](#recommended-agent-rule) into `AGENTS.md` in the project root, or into the project instructions, then let Codex run `agent-device` in the terminal:

```bash
agent-device open <app-or-url> --platform ios --foreground
```

If Codex can't find `agent-device`, see [Fix a missing agent-device command](#fix-a-missing-agent-device-command).

For reviews or planning-only tasks, tell the agent not to touch devices unless you ask.

## Claude Code

Claude Code can use `agent-device` from the terminal or from the VS Code extension. The VS Code extension uses MCP servers you add with the `claude` CLI and manage with `/mcp`.

### Claude Code: use the CLI

Open `CLAUDE.md` in the project root, creating it if it doesn't exist. Add an `# agent-device` heading and paste the [recommended agent rule](#recommended-agent-rule) below it. Keep any instructions already in the file.

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

If the client supports project rules or custom instructions, paste the [recommended agent rule](#recommended-agent-rule) there, inside any wrapper the client requires for a rules file. If it doesn't, ask the agent to open the requested app and continue from the initial interactive snapshot; point it to a help topic only when the task is specialized or a command is unclear.

## Related pages

For supported targets, evidence features, and how `agent-device` differs from scripted test frameworks, see [Introduction](/docs/introduction). For command groups and platform behavior, see [Commands](/docs/commands).

For the local execution model, permissions, artifacts, and sensitive data guidance, see [Security and trust](/docs/security-trust).

## Agent-readable docs

Use [llms-full.txt](https://agent-device.dev/llms-full.txt) when an agent needs the whole documentation as one text file. For exact command syntax, the installed CLI help is authoritative:

```bash
agent-device help
agent-device help workflow
agent-device help dogfood
```
