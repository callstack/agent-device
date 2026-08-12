// Minimal package-script splitting for suite registration. Workflow ownership never uses it.

/** `VAR=x VAR2="y z" ` at the head of a segment. */
export const ENV_PREFIX = /^(?:[A-Z_][A-Z0-9_]*=(?:"[^"]*"|'[^']*'|\S*)\s+)+/;

/**
 * `a && b`, `a; b`, and `a | b` all run both sides; newlines and `\` continuations join
 * first. Env prefixes are LEFT ON: `NODE_OPTIONS=--import ./x.ts pnpm gate lint` runs
 * code, so a caller deciding whether a segment is a bare gate invocation has to see it.
 */
export function commandSegments(body: string): string[] {
  return body
    .replace(/\\\n/g, ' ')
    .split('\n')
    .map(stripComment)
    .join('\n')
    .split(/&&|\|\||[;\n|]/)
    .map((segment) => segment.trim())
    .filter(Boolean);
}

/** `echo done # && pnpm test:unit` must not credit test:unit. Quotes protect a literal `#`. */
function stripComment(line: string): string {
  for (const match of line.matchAll(/"[^"]*"|'[^']*'|(?:^|\s)#/g)) {
    if (match[0].endsWith('#')) return line.slice(0, match.index);
  }
  return line;
}
