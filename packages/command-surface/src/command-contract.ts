import type { InputAudienceMap } from './input-audience.ts';

export type JsonSchema = {
  type?: string | readonly string[];
  description?: string;
  pattern?: string;
  properties?: Record<string, JsonSchema>;
  required?: readonly string[];
  additionalProperties?: boolean | JsonSchema;
  items?: JsonSchema;
  minItems?: number;
  maxItems?: number;
  oneOf?: readonly JsonSchema[];
  not?: JsonSchema;
  enum?: readonly unknown[];
  const?: unknown;
  minimum?: number;
  maximum?: number;
  /**
   * Marks this object as ANOTHER command's input, naming the sibling property
   * that holds that command's name. Model-facing admission recurses into it
   * with that command's own advertised schema (`mcp/command-tools.ts`).
   */
  commandInputFor?: string;
};

/** Read excludes artifact writes and foreground changes. Write covers non-destructive updates. */
export type CommandEffect = 'read' | 'write' | 'destructive';

export type CommandMetadata<Name extends string, Input> = CommandInputMetadata<Name, Input> & {
  title: string;
  effect: CommandEffect;
};

export type CommandInputMetadata<Name extends string, Input> = {
  name: Name;
  description: string;
  /**
   * MCP-only tail appended to `description` for the MCP tool surface. Stored as the tail alone
   * so `description` remains the single home of the canonical body for CLI help, `explain`,
   * the executable definition, and docs. Compose with `mcpBody`.
   */
  mcpDetail?: string;
  inputSchema: JsonSchema;
  readInput: (input: unknown) => Input;
  /**
   * Non-model audiences this command's own input keys declare
   * (`input-audience.ts`). `retired` keys are excluded from
   * `inputSchema` but still recognized, so the MCP admission boundary lets one
   * through to `readInput`'s migration guidance instead of rejecting it as
   * unknown; `operator` keys stay in `inputSchema` for the CLI and the Node
   * client, and the MCP boundary hides and refuses them.
   *
   * Required, and empty for most commands: a field that declares an audience is
   * only honored because its command carries it here, so leaving this optional
   * would make "forgot to wire it up" a silent model-writable credential rather
   * than a type error. `defineFieldCommandMetadata` derives it from the field
   * map, which is why that is the one construction path for a field command.
   */
  inputAudience: InputAudienceMap;
  /**
   * This command's default stdout IS the value — a read result, an attribute map, an
   * artifact path — so a caller pipes it straight onward and a line appended after it
   * changes what they receive. The single CLI dispatcher reads this to send the
   * response's `Warning:` lines to stderr instead of stdout (#2682): every other
   * command prints them after its own text, and no formatter decides this per-command.
   */
  parseableOutput?: true;
  /**
   * The keys of a minimal valid call that a placeholder per required property cannot state, such
   * as the one UI target an interaction needs. `commandInputExample` merges them over those.
   */
  inputExample?: Readonly<Record<string, unknown>>;
};

export function defineCommandMetadata<Name extends string, Input>(
  definition: CommandInputMetadata<Name, Input>,
): CommandInputMetadata<Name, Input> {
  return definition;
}

/**
 * A minimal call for a command: a placeholder for each required property, then its declared
 * example keys, which win. A model-facing surface shows it when a call names an argument the tool does not take,
 * so a caller that never loaded the schema can retry once.
 */
export function commandInputExample(
  metadata: Pick<CommandMetadata<string, unknown>, 'inputSchema' | 'inputExample'>,
): Record<string, unknown> {
  return { ...requiredPropertiesExample(metadata.inputSchema), ...metadata.inputExample };
}

function requiredPropertiesExample(schema: JsonSchema): Record<string, unknown> {
  return Object.fromEntries(
    (schema.required ?? []).map((key) => [key, placeholder(key, schema.properties?.[key])]),
  );
}

function placeholder(key: string, schema: JsonSchema | undefined): unknown {
  if (schema === undefined) return `<${key}>`;
  if (schema.const !== undefined) return schema.const;
  if (schema.enum !== undefined && schema.enum.length > 0) return schema.enum[0];
  if (schema.oneOf !== undefined && schema.oneOf.length > 0)
    return placeholder(key, schema.oneOf[0]);
  switch (Array.isArray(schema.type) ? schema.type[0] : schema.type) {
    case 'object':
      return requiredPropertiesExample(schema);
    case 'array':
      return schema.items === undefined ? [] : [placeholder(key, schema.items)];
    case 'number':
    case 'integer':
      return schema.minimum ?? 1;
    case 'boolean':
      return true;
    default:
      return `<${key}>`;
  }
}
