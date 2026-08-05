import type { CommandSchemaOverride } from '../cli-schema/types.ts';

/**
 * One canonical description per command, plus an optional tail per surface.
 *
 * There is deliberately no per-surface description *override*: a surface can only append
 * to the shared body, never replace it, so CLI help and MCP tool text cannot drift apart.
 * Terminal-only vocabulary — flags, positional syntax, `agent-device` examples — belongs in
 * `cliDetail`, which the MCP surface never reads; that is what keeps MCP descriptions free of
 * CLI syntax structurally rather than by review.
 *
 * Input fields are documented once, in the command's `inputSchema`. Both surfaces already
 * render those descriptions (MCP sends the schema with the tool, `--help` prints the flag
 * section), so guidance never restates them.
 */
export type CommandGuidance = {
  /** Canonical intent. Defaults to the CLI help description, then the command metadata description. */
  description?: string;
  /** Appended to CLI help only: flags, positional syntax, terminal examples. */
  cliDetail?: string;
  /** Appended to the MCP tool description only: when-to-use and sequencing hints. */
  mcpDetail?: string;
};

export function projectCommandGuidance(
  metadataDescription: string,
  cliSchema: CommandSchemaOverride | undefined,
  guidance: CommandGuidance | undefined,
): { cliSchema: CommandSchemaOverride | undefined; mcpDescription: string } {
  // `summary` is the short list-view line, so it is deliberately not in this chain:
  // falling back to it would replace a full description with a fragment on both surfaces.
  const shared = guidance?.description ?? cliSchema?.helpDescription ?? metadataDescription;
  return {
    cliSchema:
      (cliSchema ?? guidance)
        ? {
            ...cliSchema,
            helpDescription: appendDetail(shared, guidance?.cliDetail),
          }
        : undefined,
    mcpDescription: appendDetail(shared, guidance?.mcpDetail),
  };
}

function appendDetail(description: string, detail: string | undefined): string {
  return detail ? `${description} ${detail}` : description;
}
