import {
  operatorAudience,
  type InputAudience,
  type InputAudienceMap,
  type JsonSchema,
} from '@agent-device/command-surface';

/**
 * The MCP surface's own controls: the state directory and response shaping it
 * adds on top of a command's input, consumes itself, and never forwards to the
 * command route. One row per key, so the keys stripped before dispatch and the
 * audience boundary read one declaration.
 *
 * Every row is operator-owned: the operator sets it for the whole server with
 * the CLI flag's `AGENT_DEVICE_*` environment variable or config key, which
 * `tool-input-config.ts` merges into each call. No tool schema advertises
 * these keys, so they cost no schema bytes on any tool, and a call that passes
 * one is refused with the operator path.
 */
type McpToolConfigFieldSpec = {
  /** The schema env/config defaults resolve against; never advertised. */
  schema: JsonSchema;
  audience: InputAudience;
};

const MCP_TOOL_CONFIG_FIELDS = {
  stateDir: {
    schema: { type: 'string' },
    // Selects which daemon state directory (and therefore which daemon and
    // session namespace) a call resolves against: operator infrastructure, not
    // per-call work.
    audience: operatorAudience({ operatorConfig: true }),
  },
  // Keyed by the CLI flag (`--cost`, `--level`), so the flag's env/config default reaches the
  // call through the same resolver as every other flag.
  cost: {
    schema: { type: 'boolean' },
    audience: operatorAudience({ operatorConfig: true }),
  },
  responseLevel: {
    schema: { type: 'string', enum: ['digest', 'default', 'full'] },
    audience: operatorAudience({ operatorConfig: true }),
  },
} as const satisfies Record<string, McpToolConfigFieldSpec>;

const MCP_TOOL_CONFIG_ROWS: ReadonlyArray<readonly [string, McpToolConfigFieldSpec]> =
  Object.entries(MCP_TOOL_CONFIG_FIELDS);

/** Tool arguments the MCP surface consumes itself and never forwards to the command route. */
export const MCP_TOOL_CONFIG_KEYS: ReadonlySet<string> = new Set(
  MCP_TOOL_CONFIG_ROWS.map(([key]) => key),
);

/**
 * Config-file-loading keys. Not per-command flags but flags the MCP config
 * resolver reads to load an arbitrary file; never model-writable, since that
 * file can carry operator credentials and endpoints. They appear in no tool
 * schema, so admission rejects them like any unadvertised key — with a message
 * that points at the operator path instead of the generic unknown-key text.
 */
export const CONFIG_LOADER_AUDIENCE: InputAudienceMap = {
  config: operatorAudience({
    operatorPath:
      'Point the process serving these tools at a config file with the AGENT_DEVICE_CONFIG environment variable.',
  }),
  remoteConfig: operatorAudience({
    operatorPath:
      'Configure the remote profile on the process serving these tools, not per tool call.',
  }),
};

export const MCP_TOOL_CONFIG_AUDIENCE: InputAudienceMap = Object.fromEntries(
  MCP_TOOL_CONFIG_ROWS.map(([key, field]) => [key, field.audience]),
);

export function mcpToolConfigProperties(): Record<string, JsonSchema> {
  return Object.fromEntries(MCP_TOOL_CONFIG_ROWS.map(([key, field]) => [key, field.schema]));
}
