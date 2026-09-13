/**
 * Every word a command shows a human or a model, in one place.
 *
 * Each field answers a different question, so none can substitute for another and none needs a
 * fallback chain:
 *
 *   summary      what is this command, in a list of ninety?
 *   description  what does it do, and when should I reach for it?
 *   cliDetail    what else does a terminal user need — flags, argument shapes, examples?
 *   mcpDetail    what else does a model need — sequencing, cross-tool hints?
 *
 * `--help`, the command list, the MCP tool description and `explain` are all projections of
 * these four, computed where they are rendered rather than written back into the schema. That
 * is deliberate: the field this replaced was authored on some commands and generated on others,
 * which is how surfaces silently drifted apart.
 *
 * Because `cliDetail` is the only field carrying terminal vocabulary, and the MCP surface never
 * reads it, MCP descriptions stay free of flags and positional syntax structurally rather than
 * by a review guard.
 */
export type CommandText = {
  /** One line for the command list. Imperative, no trailing period, fits a terminal column. */
  summary: string;
  /** Canonical description: the MCP tool text, `explain`, the docs site, and the `--help` body. */
  description: string;
  /** Appended to the `--help` body only: flags, positional syntax, terminal examples. */
  cliDetail?: string;
  /** Appended to the MCP tool description only: when-to-use and sequencing hints. */
  mcpDetail?: string;
};

/**
 * What a command backed by a family facet authors. `description` is absent because the facet's
 * metadata already carries it — repeating it here would leave a shadowed copy behind, which is
 * exactly the dead-literal problem this file's predecessor had.
 */
export type FacetCommandText = Omit<CommandText, 'description'>;

/** The `--help` body: canonical description plus any terminal-only detail. */
export function helpBody(text: CommandText): string {
  return join(text.description, text.cliDetail);
}

/** The MCP tool description: canonical description plus any model-only detail. */
export function mcpBody(text: Pick<CommandText, 'description' | 'mcpDetail'>): string {
  return join(text.description, text.mcpDetail);
}

/** Resolves a facet's authored text against the description its metadata already holds. */
export function resolveFacetText(text: FacetCommandText, description: string): CommandText {
  return { ...text, description };
}

function join(description: string, detail: string | undefined): string {
  return detail ? `${description} ${detail}` : description;
}
