// Reading a workflow `run:` block as a list of commands.
//
// Deliberately shallow: this covers the shapes CI actually uses (a few commands per block,
// joined by newlines and `&&`), and nothing here decides what a command *means* — that is
// execution-terminals.ts. The split matters because "produces no terminal" can never grant
// ownership, so an unreadable command leaves a suite unowned (a reported failure) rather than
// silently claiming it is covered.

/** Drops `#` comments while leaving `#` inside a quoted string alone. */
function stripShellComments(run: string): string {
  return run
    .split('\n')
    .map((line) => {
      let quote: string | null = null;
      for (let index = 0; index < line.length; index++) {
        const char = line[index]!;
        if (quote) {
          if (char === quote) quote = null;
          continue;
        }
        if (char === '"' || char === "'") {
          quote = char;
          continue;
        }
        // A comment starts at an unquoted `#` that begins a word.
        if (char === '#' && (index === 0 || /\s/.test(line[index - 1]!)))
          return line.slice(0, index);
      }
      return line;
    })
    .join('\n');
}

/**
 * Index of the `)` closing the `(` at `open`, or the end of the string. Balanced, so a
 * substitution containing `)` — as in `$(node -p "require('./package.json').version")` — is
 * measured whole rather than cut at the first inner paren.
 */
function endOfBalancedParen(run: string, open: number): number {
  let depth = 0;
  for (let cursor = open; cursor < run.length; cursor++) {
    if (run[cursor] === '(') depth++;
    else if (run[cursor] === ')' && --depth === 0) return cursor;
  }
  return run.length;
}

/** Index just past a substitution starting at `index`, or -1 when none starts there. */
function endOfSubstitution(run: string, index: number): number {
  if (run[index] === '`') {
    const close = run.indexOf('`', index + 1);
    return close === -1 ? run.length : close;
  }
  if (run[index] === '$' && run[index + 1] === '(') return endOfBalancedParen(run, index + 1);
  return -1;
}

/**
 * Removes `$(…)` command substitutions and backtick spans. Their contents are values, not the
 * command being run — `APP="$(find "${{ github.workspace }}/…")"` is an assignment, and reading
 * the `${{ … }}` inside it as an unresolved command position would report a dynamic-dispatch
 * edge that is not one.
 */
function stripCommandSubstitutions(run: string): string {
  let out = '';
  for (let index = 0; index < run.length; index++) {
    const end = endOfSubstitution(run, index);
    if (end === -1) out += run[index];
    else index = end;
  }
  return out;
}

/** Splits a `run:` block into individual commands on newlines and shell operators. */
export function commandSegments(run: string): string[] {
  return stripCommandSubstitutions(stripShellComments(run))
    .replace(/\\\n/g, ' ')
    .split(/\n|&&|\|\||;|\|/)
    .map((segment) => segment.trim())
    .filter(Boolean);
}

export function tokenize(segment: string): string[] {
  return segment.split(/\s+/).filter(Boolean);
}

/** `VAR=value` prefixes are environment, not the command; strip them and report what is left. */
export function stripEnvPrefix(tokens: readonly string[]): string[] {
  let index = 0;
  while (index < tokens.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[index]!)) index++;
  return tokens.slice(index);
}

export function isDynamic(token: string): boolean {
  return token.includes('${{') || token.startsWith('$');
}

/**
 * Positional arguments that identify the unit of work: subcommands and repo paths. Flags and
 * their values are dropped so `pnpm test:replay:macos --retries 2` and the bare script resolve
 * to the same terminal, while `bin.ts test <ios-dir>` and `bin.ts test <macos-dir>` stay
 * distinct. Interpolated arguments (`$VERSION`, a leftover `${{ … }}`) are dropped too: they
 * carry no stable identity, so keeping them would make a workflow's invocation of a script
 * spuriously differ from the script's own.
 */
export function positionalArgs(tokens: readonly string[]): string[] {
  const args: string[] = [];
  for (let index = 0; index < tokens.length; index++) {
    const token = tokens[index]!;
    if (token.startsWith('-')) {
      // `--flag value` — skip the value too, unless it is itself a flag or the flag used `=`.
      const next = tokens[index + 1];
      if (!token.includes('=') && next !== undefined && !next.startsWith('-')) index++;
      continue;
    }
    if (token.includes('$')) continue;
    args.push(token.replace(/^['"]|['"]$/g, ''));
  }
  return args;
}
