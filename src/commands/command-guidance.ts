import type { CommandSchemaOverride } from '../cli-schema/types.ts';
import type { FlagKey } from './cli-grammar/flag-types.ts';
import type { JsonSchema } from './command-contract.ts';

export type CommandGuidance = {
  /** Surface-neutral intent shared by the CLI, MCP, and command explanation. */
  description?: string;
  cli?: {
    /** Replaces the shared description when terminal phrasing needs to differ. */
    description?: string;
    /** CLI-only operational detail that does not belong in an MCP tool description. */
    detail?: string;
    /** Flags worth naming in the CLI synopsis; full flag docs remain in the flag section. */
    flags?: readonly FlagKey[];
  };
  mcp?: {
    /** Replaces the shared description when MCP phrasing needs to differ. */
    description?: string;
    /** MCP-only operational detail that does not belong in terminal help. */
    detail?: string;
    /** Input fields whose schema descriptions should be appended to the MCP tool description. */
    parameters?: readonly string[];
  };
};

export function projectCommandGuidance(
  fallbackDescription: string,
  cliSchema: CommandSchemaOverride | undefined,
  inputSchema: JsonSchema,
  guidance: CommandGuidance | undefined,
): { cliSchema: CommandSchemaOverride | undefined; mcpDescription: string } {
  const shared =
    guidance?.description ??
    cliSchema?.helpDescription ??
    cliSchema?.summary ??
    fallbackDescription;
  return {
    cliSchema: injectCliGuidance(guidance?.cli?.description ?? shared, cliSchema, guidance?.cli),
    mcpDescription: injectMcpGuidance(
      guidance?.mcp?.description ?? shared,
      inputSchema,
      guidance?.mcp,
    ),
  };
}

function injectCliGuidance(
  shared: string,
  cliSchema: CommandSchemaOverride | undefined,
  guidance: CommandGuidance['cli'] | undefined,
): CommandSchemaOverride | undefined {
  if (!cliSchema && !guidance) return undefined;
  const flagNames = guidance?.flags?.map((flag) => `--${toKebabCase(flag)}`) ?? [];
  const additions = [
    guidance?.detail,
    flagNames.length > 0 ? `Relevant flags: ${flagNames.join(', ')}.` : undefined,
  ]
    .filter((value): value is string => Boolean(value))
    .join(' ');
  return { ...cliSchema, helpDescription: [shared, additions].filter(Boolean).join(' ') };
}

function injectMcpGuidance(
  shared: string,
  inputSchema: JsonSchema,
  guidance: CommandGuidance['mcp'] | undefined,
): string {
  const properties = inputSchema.properties ?? {};
  const parameterHints = (guidance?.parameters ?? []).flatMap((name) => {
    const description = properties[name]?.description;
    return description ? [`${name}: ${description}`] : [];
  });
  const additions = [
    guidance?.detail,
    parameterHints.length > 0 ? `Key inputs: ${parameterHints.join(' ')}` : undefined,
  ].filter((value): value is string => Boolean(value));
  return [shared, ...additions].join(' ');
}

function toKebabCase(value: string): string {
  return value.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`);
}
