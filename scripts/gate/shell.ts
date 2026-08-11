// Splitting a shell body into the segments that run something.
//
// Deliberately the whole of this file's ambition. Three review rounds established that
// deciding what a command DOES is not answerable from its text (`pnpm exec`, then
// `pnpm exec --`/`npx --yes`, then `node -e 'import(…)'`), so nothing here interprets a
// segment — the callers ask only "is this segment exactly a gate invocation?" (audit.ts)
// and "which package script does it name?" (model.ts).

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

/**
 * GitHub evaluates `${{ … }}` before the shell sees it, so it is not shell syntax.
 * The placeholder deliberately contains no shell metacharacters: an earlier `<expr>`
 * collided with the redirection characters the gate grammar rejects, so every gate
 * step carrying a matrix expression looked like a bypass.
 *
 * This pins the expression TEMPLATE, not what GitHub substitutes into it. An expression
 * whose value comes from the event (`github.event.pull_request.title`) is script
 * injection that this manifest does not claim to catch; `inputs.*` is covered, because
 * the substituted value is written in this repo and audited at each call site.
 */
export function stripExpressions(text: string): string {
  return text.replace(/\$\{\{[^}]*\}\}/g, 'GITHUB_EXPR');
}
