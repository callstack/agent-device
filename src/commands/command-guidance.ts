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
 * The body itself is not part of this type: it is the command's own `description`, so there is
 * one place to write it and no shadowed copy left behind in the metadata literal.
 *
 * Input fields are documented once, in the command's `inputSchema`. Both surfaces already
 * render those descriptions (MCP sends the schema with the tool, `--help` prints the flag
 * section), so guidance never restates them.
 */
export type CommandGuidance = {
  /** Appended to CLI help only: flags, positional syntax, terminal examples. */
  cliDetail?: string;
  /** Appended to the MCP tool description only: when-to-use and sequencing hints. */
  mcpDetail?: string;
};

export type ProjectedCommandGuidance = {
  /**
   * The canonical body. Every surface that describes the command reads this — CLI help (before
   * its own tail), `explain`, the executable definition, and the MCP tool (before its own tail) —
   * so no consumer can be left holding a stale variant.
   */
  description: string;
  cliSchema: CommandSchemaOverride | undefined;
  /** MCP-only tail. Stored on its own rather than as a second full string, so the body has one home. */
  mcpDetail: string | undefined;
};

export function projectCommandGuidance(
  metadataDescription: string,
  cliSchema: CommandSchemaOverride | undefined,
  guidance: CommandGuidance | undefined,
): ProjectedCommandGuidance {
  // `summary` is the short list-view line, so it is deliberately not in this chain:
  // falling back to it would replace a full description with a fragment on every surface.
  const description = cliSchema?.helpDescription ?? metadataDescription;
  return {
    description,
    cliSchema:
      (cliSchema ?? guidance)
        ? { ...cliSchema, helpDescription: appendDetail(description, guidance?.cliDetail) }
        : undefined,
    mcpDetail: guidance?.mcpDetail,
  };
}

/** Composes the MCP tool description from the canonical body and the MCP-only tail. */
export function composeMcpDescription(command: {
  description: string;
  mcpDetail?: string;
}): string {
  return appendDetail(command.description, command.mcpDetail);
}

function appendDetail(description: string, detail: string | undefined): string {
  return detail ? `${description} ${detail}` : description;
}
