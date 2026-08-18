import type { JsonSchema } from '../commands/command-contract.ts';
import { buildCommandUsageText, buildUsageText, helpTopicIds } from '../cli-schema/cli-help.ts';
import { listCliCommandNames } from '../command-catalog.ts';
import { normalizeCliCommandAlias } from '../commands/cli-command-aliases.ts';
import { listMcpExposedCommandNames } from '../core/command-descriptor/registry.ts';
import type { ToolResult } from './command-tools.ts';

/**
 * Server instructions: the workflow card an MCP client injects into the model's context
 * at session start (Claude Code, Codex CLI). It is paid every session and Claude Code
 * truncates it at 2 KB, so it holds only what changes the first few calls: start with
 * `open`, act → settled diff → verify → `close`, ref fidelity, sparse-AX recovery, follow
 * error hints. Everything situational lives behind the `help` tool.
 */
export const MCP_SERVER_INSTRUCTIONS = `agent-device drives iOS, Android, tvOS, Android TV, macOS, Linux, and web apps. Tools mirror CLI commands of the same name; CLI flags are camelCase properties (--settle -> settle: true).

Start: known app -> call open {app, foreground: true} at once; do not probe with devices, apps, appstate, snapshot, or screenshot first. open returns the initial interactive snapshot with @refs. Unknown app id: devices, then apps, then open the discovered id; never invent ids. Existing session: continue from its state, do not reopen.

Loop: press/click/fill/longpress/hover/scroll/back with settle: true; the response is the settled UI diff, continue from it. snapshot {interactiveOnly: true} only when the diff lacks the next target or did not settle. Verify with wait {kind: "text", text}, wait {selector}, is, get, or find; a bare screenshot is not verification. End with close.

Targets: copy refs byte-for-byte (@e12, @e12~s4; keep @ and any ~sN). Refs go stale after mutations. Prefer refs, then id/label/role selectors; coordinates last. On a sparse/AX-unavailable warning its refs and selectors are invalid: screenshot, read the image, press {x, y}, then snapshot the changed screen.

Errors carry hints; follow them instead of re-planning. Call help only for specialized work (gestures, scripting, TV, macOS, web, remote, debugging) or an unclear command shape, never at startup.`;

export const HELP_TOOL_NAME = 'help';

/**
 * CLI commands with no MCP tool (`web setup`, `daemon stop`, `connect`, …): the guides
 * mention them as `agent-device <command>` lines, and an MCP-only client must know those
 * are shell steps, not tools. Derived from the two registries rather than scanned out of
 * each guide's prose: `device` and `web` are ordinary words there, so a mention detector
 * would be a heuristic; the registry difference is exact and holds for every guide.
 */
export function terminalOnlyCommandNames(): string[] {
  const exposed = new Set<string>(listMcpExposedCommandNames());
  return listCliCommandNames().filter((name) => !exposed.has(name));
}

/**
 * MCP-only discovery tool. Not a command descriptor: it drives no device, so it carries
 * none of the routing/timeout/batch traits descriptors exist to declare, and adding it
 * there would also mint a redundant CLI command next to `agent-device help`.
 */
export const HELP_TOOL: { name: string; description: string; inputSchema: JsonSchema } = {
  name: HELP_TOOL_NAME,
  description: `Usage guides. No topic: the full workflow card. topic = one of ${helpTopicIds().join(', ')} for that guide, or a tool name for its complete flag reference. For specialized work or an unclear command shape only; not a startup step, not needed after an error that carries a hint.`,
  inputSchema: {
    type: 'object',
    properties: {
      topic: { type: 'string', description: 'Guide topic or tool name; omit for the card.' },
    },
    additionalProperties: false,
  },
};

// The guides are the CLI's own text: rewriting their prose per surface would fork one
// source of truth into two. One line up front states the mapping and its exceptions.
const GUIDE_PREAMBLE = `CLI syntax over MCP: \`agent-device <command> <positionals> --flag\` = tool <command>; positionals are named properties (target, text, direction), flags camelCase (--settle -> settle: true, -i -> interactiveOnly: true). Terminal-only (no MCP tool; run in a shell): ${terminalOnlyCommandNames().join(', ')}.\n\n`;

export function callHelpTool(input: Record<string, unknown>): ToolResult {
  const topic = input.topic;
  if (topic !== undefined && typeof topic !== 'string') {
    return textResult('Expected topic to be a string.', true);
  }
  const text = topic ? buildCommandUsageText(normalizeCliCommandAlias(topic)) : buildUsageText();
  if (text === null) {
    return textResult(`Unknown help topic: ${topic}. ${HELP_TOOL.description}`, true);
  }
  return textResult(GUIDE_PREAMBLE + text);
}

function textResult(text: string, isError = false): ToolResult {
  return { isError, content: [{ type: 'text', text }] };
}
