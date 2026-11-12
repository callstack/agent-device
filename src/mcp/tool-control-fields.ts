import {
  operatorAudience,
  type InputAudience,
  type InputAudienceMap,
  type JsonSchema,
} from '@agent-device/command-surface';

/**
 * The MCP surface's own tool arguments: transport and response-shaping controls
 * it adds on top of a command's input, consumes itself, and never forwards to
 * the command route. One row per key, so the advertised schema, the keys
 * stripped before dispatch, and the audience boundary read one declaration.
 *
 * Not `tool-input-config.ts`, which is the other half of the same call: that one
 * merges the operator's env and config-file defaults into a call's input.
 */
type McpToolConfigFieldSpec = {
  schema: JsonSchema;
  /** Who may write the key. Absent means the model — see `commands/input-audience.ts`. */
  audience?: InputAudience;
};

const MCP_TOOL_CONFIG_FIELDS = {
  stateDir: {
    schema: { type: 'string', description: 'Agent-device state directory.' },
    // Selects which daemon state directory (and therefore which daemon and
    // session namespace) a call resolves against: operator infrastructure, not
    // per-call work.
    audience: operatorAudience({ operatorConfig: true }),
  },
  mcpOutputFormat: {
    schema: {
      type: 'string',
      enum: ['optimized', 'json'],
      description: 'Result text: compact optimized (default) or the full result as JSON (larger).',
    },
  },
  includeCost: {
    schema: {
      type: 'boolean',
      description: 'Add agent cost (cost.wallClockMs, …) to the result.',
    },
  },
  responseLevel: {
    schema: {
      type: 'string',
      enum: ['digest', 'default', 'full'],
      description:
        'Result detail: digest (smallest) or full (largest), as JSON; default is compact text.',
    },
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
  MCP_TOOL_CONFIG_ROWS.flatMap(([key, field]) => (field.audience ? [[key, field.audience]] : [])),
);

export function mcpToolConfigProperties(): Record<string, JsonSchema> {
  return Object.fromEntries(MCP_TOOL_CONFIG_ROWS.map(([key, field]) => [key, field.schema]));
}
