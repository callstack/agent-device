import type { JsonSchema } from '../commands/command-contract.ts';
import { buildCommandUsageText, buildUsageText, helpTopicIds } from '../cli-schema/cli-help.ts';
import { normalizeCliCommandAlias } from '../commands/cli-command-aliases.ts';
import type { ToolResult } from './command-tools.ts';

/**
 * Server instructions: the workflow card an MCP client injects into the model's context
 * at session start (Claude Code, Codex CLI). It is paid every session and Claude Code
 * truncates it at 2 KB, so it holds only what changes the first few calls: start with
 * `open`, act → settled diff → verify → `close`, ref fidelity, sparse-AX recovery, follow
 * error hints. Everything situational lives behind the `help` tool.
 */
export const MCP_SERVER_INSTRUCTIONS = `agent-device drives iOS, Android, tvOS, Android TV, macOS, Linux, and web apps. Tools mirror the CLI commands of the same name; each tool description carries that command's contract. CLI flags map to camelCase properties (--settle -> settle: true).

Start: for a known app call open {app, foreground: true} immediately. Do not probe first with devices, apps, appstate, snapshot, or screenshot. open starts the session and returns the initial interactive snapshot with @refs. Unknown app id: devices, then apps, then open the discovered id; never invent ids. An existing session: continue from its current state, do not reopen.

Loop: act with press/click/fill/longpress/hover/scroll/back and settle: true. The response is the settled UI diff; continue from it. Call snapshot {interactiveOnly: true} only when the diff lacks the next target or did not settle. Verify the named expectation with wait {kind: "text", text}, wait {selector}, is, get, or find; a bare screenshot is not verification. End with close.

Targets: copy refs byte-for-byte (@e12, @e12~s4; keep the @ and any ~sN pin). Refs go stale after mutations. Prefer refs, then id/label/role selectors; coordinates are last resort. If a response reports sparse/AX-unavailable, its refs and selectors are invalid: screenshot, read the image, press {x, y}, then snapshot again on the changed screen.

Errors carry corrective hints; follow them instead of re-planning. Call help only for specialized work (gestures, scripting, TV, macOS, web, remote, debugging) or an unclear command shape, never as a startup step.`;

export const HELP_TOOL_NAME = 'help';

const HELP_TOPICS_HINT = `topics: ${helpTopicIds().join(', ')}; or any tool name for its full flag reference`;

/**
 * MCP-only discovery tool. Not a command descriptor: it drives no device, so it carries
 * none of the routing/timeout/batch traits descriptors exist to declare, and adding it
 * there would also mint a redundant CLI command next to `agent-device help`.
 */
export function helpToolDefinition(): {
  name: string;
  description: string;
  inputSchema: JsonSchema;
} {
  return {
    name: HELP_TOOL_NAME,
    description:
      'Usage guides for this server. No topic: the full workflow card (start, loop, targets, rules). ' +
      `With topic (${HELP_TOPICS_HINT}): that guide, or a tool's complete flag reference. ` +
      'Consult it for specialized work or an unclear command shape; not a startup step, and not needed after an error that already carries a hint.',
    inputSchema: {
      type: 'object',
      properties: {
        topic: {
          type: 'string',
          description: 'Guide topic or tool name. Omit for the workflow card.',
        },
      },
      additionalProperties: false,
    },
  };
}

// The guides are the CLI's own text: rewriting their prose per surface would fork one
// source of truth into two. One line up front states the mapping instead.
const MCP_GUIDE_PREAMBLE =
  'Reading CLI syntax over MCP: `agent-device <command> <positionals> --flag` is the tool named <command>; positionals are named properties (target, text, direction), flags are camelCase properties (--settle -> settle: true, -i -> interactiveOnly: true).\n';

export function callHelpTool(input: Record<string, unknown>): ToolResult {
  const topic = input.topic;
  if (topic !== undefined && typeof topic !== 'string') {
    return textResult('Expected topic to be a string.', true);
  }
  if (topic === undefined || topic.length === 0) {
    return textResult(`${MCP_GUIDE_PREAMBLE}\n${buildUsageText()}`);
  }
  const text = buildCommandUsageText(normalizeCliCommandAlias(topic));
  if (text === null) {
    return textResult(`Unknown help topic: ${topic}. Available ${HELP_TOPICS_HINT}.`, true);
  }
  return textResult(`${MCP_GUIDE_PREAMBLE}\n${text}`);
}

function textResult(text: string, isError = false): ToolResult {
  return { isError, content: [{ type: 'text', text }] };
}
