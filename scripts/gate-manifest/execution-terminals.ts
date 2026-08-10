// Resolving one command to the units of work it actually performs.
//
// A terminal is what a command ends up doing, not what it is called:
//
//   vitest:<project>        a Vitest project run
//   node-test:<file>        a `node --test` file (globs are expanded against the real tree)
//   package:<dir>#<script>  a script run inside another workspace package (`pnpm --dir`)
//   exec:<argv>             a script file executed directly, with its positional arguments
//   bin:<name>              an external tool (oxlint, tsc, fallow, ...)
//
// Resolving to terminals rather than command names is what makes ownership provable: a lane
// that runs `pnpm check:tooling` reaches the layering guard two hops later, and a renamed
// intermediate script breaks the chain instead of leaving a false claim standing. Positional
// arguments stay in `exec:` terminals so `test:replay:ios` and `test:replay:macos` — both
// running src/bin.ts — cannot be confused; flags are dropped so a CI-only `--retries 2` does
// not make the same script look like different work.
//
// Anything the walk cannot follow is reported as an UnresolvedEdge and fails the gate unless
// an explicit waiver classifies it.

import {
  commandSegments,
  isDynamic,
  positionalArgs,
  stripEnvPrefix,
  tokenize,
} from './shell-commands.ts';
import {
  IGNORED_COMMANDS,
  NODE_EVAL_FLAGS,
  PNPM_DIR_FLAGS,
  PNPM_SUBCOMMANDS,
  PNPM_WORKSPACE_FLAGS,
  SCRIPT_FILE,
} from './command-vocabulary.ts';

/** A unit of work a command ultimately performs. See the module comment for the taxonomy. */
export type Terminal = string;

/** An execution edge the static walk could not follow. Fails the gate unless waived. */
export type UnresolvedEdge = {
  /** `<workflow file>#<job>` or `package.json#<script>` — the side that failed to resolve. */
  readonly source: string;
  readonly step: string;
  readonly kind: 'dynamic-command' | 'missing-action' | 'missing-script' | 'no-terminal';
  readonly detail: string;
};

export type ResolveContext = {
  readonly packageScripts: ReadonlyMap<string, string>;
  /** `.github/actions/<name>` → action.yml source. */
  readonly actions: ReadonlyMap<string, string>;
  readonly vitestProjects: readonly string[];
  /** Expands a `node --test` path argument (possibly a glob) against the real tree. */
  readonly expandTestPaths: (pattern: string) => readonly string[];
  /**
   * Files that forward their argv verbatim to another process, so the wrapper is not itself
   * the unit of work — the command it wraps is. Declared, never guessed.
   */
  readonly transparentWrappers: ReadonlySet<string>;
  /**
   * Executables whose real work the static walk cannot see (they spawn a runner themselves),
   * mapped to the terminals they are declared to reach.
   */
  readonly declaredTerminals: ReadonlyMap<string, readonly Terminal[]>;
  /**
   * Executables that ARE a gate — they verify something and exit non-zero — while driving their
   * own runner rather than Vitest or `node --test`. Declared, because "does this executable
   * verify anything?" is not visible to a static walk. See GATE_RUNNERS in waivers.ts.
   */
  readonly gateRunners: ReadonlySet<string>;
};

export type Sink = {
  readonly terminals: Set<Terminal>;
  readonly unresolved: UnresolvedEdge[];
  readonly source: string;
  step: string;
};

export function report(sink: Sink, kind: UnresolvedEdge['kind'], detail: string): void {
  sink.unresolved.push({ source: sink.source, step: sink.step, kind, detail });
}

/**
 * The file an `exec:` terminal runs, without its positional arguments — null for every other
 * kind. `exec:src/bin.ts test test/integration/replays/ios` and `exec:src/bin.ts replay …` are
 * different units of work but the same executable, which is the question a caller asks when it
 * wants to know WHAT ran rather than with which arguments.
 */
export function execTarget(terminal: Terminal): string | null {
  if (!terminal.startsWith('exec:')) return null;
  return terminal.slice('exec:'.length).split(' ')[0] ?? null;
}

/** Which Vitest projects an invocation runs. */
function addVitestTerminals(tokens: readonly string[], ctx: ResolveContext, sink: Sink): void {
  const projects: string[] = [];
  for (let index = 0; index < tokens.length; index++) {
    const token = tokens[index]!;
    if (token === '--project' && tokens[index + 1]) projects.push(tokens[index + 1]!);
    else if (token.startsWith('--project=')) projects.push(token.slice('--project='.length));
  }
  // No `--project` filter means Vitest runs every configured project, which is exactly how the
  // Coverage lane owns all five of them without naming any.
  const selected = projects.length > 0 ? projects : ctx.vitestProjects;
  for (const project of selected) sink.terminals.add(`vitest:${project}`);
}

/** The script `node` will run, and the arguments after it. Null when there is no script. */
function nodeEntryPoint(tokens: readonly string[]): { entry: string; rest: string[] } | null {
  const rest = [...tokens];
  while (rest.length > 0) {
    const candidate = rest.shift()!;
    if (NODE_EVAL_FLAGS.has(candidate)) return null;
    if (!candidate.startsWith('-')) return { entry: candidate, rest };
  }
  return null;
}

/**
 * A `node …` invocation. `--test` turns the remaining path arguments into individual test-file
 * terminals (globs expanded against the tree, so `test/integration/*.test.ts` provably covers
 * `test/integration/smoke-*.test.ts`). A declared transparent wrapper drops out and resolution
 * continues with what it forwards.
 */
function addNodeTerminals(tokens: readonly string[], ctx: ResolveContext, sink: Sink): void {
  const found = nodeEntryPoint(tokens);
  if (found === null) return;
  const { entry, rest } = found;
  if (ctx.transparentWrappers.has(entry)) {
    addNodeTerminals(rest, ctx, sink);
    return;
  }
  if (!tokens.includes('--test')) {
    addExecTerminal(entry, rest, ctx, sink);
    return;
  }
  // The wrapper case already returned; a `--test` run whose entry is a real file means the
  // entry itself is the first test path.
  for (const pattern of [entry, ...positionalArgs(rest)]) {
    for (const file of ctx.expandTestPaths(pattern)) sink.terminals.add(`node-test:${file}`);
  }
}

function addExecTerminal(
  entry: string,
  rest: readonly string[],
  ctx: ResolveContext,
  sink: Sink,
): void {
  const normalized = entry.replace(/^\.\//, '');
  const args = positionalArgs(rest);
  sink.terminals.add(`exec:${[normalized, ...args].join(' ')}`);
  // An executable that spawns its own runner is opaque to this walk; the waiver says what it
  // really reaches so the suites behind it are not silently unowned.
  for (const declared of ctx.declaredTerminals.get(normalized) ?? []) sink.terminals.add(declared);
}

/**
 * Consumes pnpm's leading flags from `rest`, returning the package directory the invocation was
 * redirected into, or null when it targets the root package.
 */
function takePnpmDirectory(rest: string[]): string | null {
  let directory: string | null = null;
  while (rest.length > 0 && rest[0]!.startsWith('-')) {
    const flag = rest.shift()!;
    if (!PNPM_DIR_FLAGS.has(flag)) continue;
    if (PNPM_WORKSPACE_FLAGS.has(flag)) directory = directory ?? '(workspace)';
    else directory = rest.shift() ?? '(unknown)';
  }
  return directory;
}

/** What a `pnpm …` invocation targets, once its flags and subcommand are read. */
type PnpmTarget = { kind: 'script'; name: string } | { kind: 'exec' } | { kind: 'none' };

function takePnpmTarget(rest: string[]): PnpmTarget {
  if (rest.length === 0) return { kind: 'none' };
  const head = rest.shift()!;
  if (head === 'exec') return { kind: 'exec' };
  if (head === 'run') {
    return rest.length === 0 ? { kind: 'none' } : { kind: 'script', name: rest.shift()! };
  }
  if (PNPM_SUBCOMMANDS.has(head) || head.startsWith('-')) return { kind: 'none' };
  return { kind: 'script', name: head };
}

function resolvePnpm(
  tokens: readonly string[],
  ctx: ResolveContext,
  sink: Sink,
  chain: ReadonlySet<string>,
): void {
  const rest = [...tokens];
  const directory = takePnpmDirectory(rest);
  const target = takePnpmTarget(rest);
  if (target.kind === 'none') return;
  if (target.kind === 'exec') {
    // Everything after `exec` is a plain command again.
    resolveTokens(rest, ctx, sink, chain);
    return;
  }
  const { name } = target;
  if (isDynamic(name)) {
    report(sink, 'dynamic-command', `pnpm script name is an unresolved expression: "${name}"`);
    return;
  }
  if (directory !== null) {
    // Another package's script graph; this manifest owns the root's lanes, so record the edge
    // as a terminal rather than descending into a second package.json.
    sink.terminals.add(`package:${directory}#${name}`);
    return;
  }
  const command = ctx.packageScripts.get(name);
  if (command === undefined) {
    report(
      sink,
      'missing-script',
      `"pnpm ${name}" names no package.json script — the script was renamed or removed, ` +
        `so whatever invoked it no longer runs anything`,
    );
    return;
  }
  resolveScript(name, command, ctx, sink, chain);
}

/** Walks a package script's command string, guarding against alias cycles. */
export function resolveScript(
  name: string,
  command: string,
  ctx: ResolveContext,
  sink: Sink,
  chain: ReadonlySet<string> = new Set(),
): void {
  if (chain.has(name)) return;
  const nested = new Set([...chain, name]);
  for (const segment of commandSegments(command)) {
    resolveTokens(tokenize(segment), ctx, sink, nested);
  }
}

function resolveShell(
  rest: readonly string[],
  ctx: ResolveContext,
  sink: Sink,
  _chain: ReadonlySet<string>,
): void {
  const entry = rest.find((token) => !token.startsWith('-'));
  if (entry === undefined) return;
  if (isDynamic(entry)) {
    report(sink, 'dynamic-command', `shell script path is an unresolved expression: "${entry}"`);
    return;
  }
  addExecTerminal(entry, rest.slice(rest.indexOf(entry) + 1), ctx, sink);
}

type CommandHandler = (
  rest: readonly string[],
  ctx: ResolveContext,
  sink: Sink,
  chain: ReadonlySet<string>,
) => void;

/** Launchers whose arguments decide what really runs, keyed by the word in command position. */
const COMMAND_HANDLERS: ReadonlyMap<string, CommandHandler> = new Map<string, CommandHandler>([
  ['pnpm', (rest, ctx, sink, chain) => resolvePnpm(rest, ctx, sink, chain)],
  ['npx', (rest, ctx, sink, chain) => resolveTokens(rest, ctx, sink, chain)],
  ['bunx', (rest, ctx, sink, chain) => resolveTokens(rest, ctx, sink, chain)],
  ['node', (rest, ctx, sink) => addNodeTerminals(rest, ctx, sink)],
  ['bun', (rest, ctx, sink) => addNodeTerminals(rest, ctx, sink)],
  ['sh', resolveShell],
  ['bash', resolveShell],
  ['zsh', resolveShell],
  ['vitest', (rest, ctx, sink) => addVitestTerminals(rest, ctx, sink)],
]);

export function resolveTokens(
  raw: readonly string[],
  ctx: ResolveContext,
  sink: Sink,
  chain: ReadonlySet<string>,
): void {
  const tokens = stripEnvPrefix(raw);
  if (tokens.length === 0) return;
  const command = tokens[0]!;
  const rest = tokens.slice(1);

  if (isDynamic(command)) {
    report(sink, 'dynamic-command', `command position is an unresolved expression: "${command}"`);
    return;
  }
  const handler = COMMAND_HANDLERS.get(command);
  if (handler) {
    handler(rest, ctx, sink, chain);
    return;
  }
  if (SCRIPT_FILE.test(command)) {
    addExecTerminal(command, rest, ctx, sink);
    return;
  }
  if (IGNORED_COMMANDS.has(command)) return;
  // A tool binary (oxlint, tsc, tsdown, fallow, fr, publint, …). Recorded so a lane that runs
  // it can own a catalog script that runs the same tool.
  sink.terminals.add(`bin:${command} ${positionalArgs(rest).join(' ')}`.trim());
}
