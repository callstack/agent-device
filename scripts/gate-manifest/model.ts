// Gate-of-gates: the derived manifest that proves every check is owned, wired, and reachable
// (#1429).
//
// Every other gate in this repo answers "is the code right?". This one answers the question
// none of them can ask about themselves: "is the gate still running at all?" A perfectly
// designed check that silently stops executing is indistinguishable from a green build, and
// two verified instances of exactly that shape motivated this module:
//
//   - `CHECK_CATALOG.ciJobs` (scripts/check-affected/checks.ts) names CI jobs as free strings.
//     `assertCatalogComplete` covers only the CheckId universe, so renaming or deleting a
//     workflow job leaves a catalog entry pointing at nothing and nothing fails.
//   - ci.yml's `paths-ignore` excludes `website/**`, so a gate that conceptually owns docs
//     paths never fires on a docs-only PR (#1420).
//
// The model is derived from the real sources — .github/workflows/*.yml, .github/actions/*,
// package.json scripts, vitest.config.ts — so there is no hand-maintained second list to fall
// out of sync. What cannot be derived fails closed and must be classified by an explicit
// waiver carrying a reason and a tracking issue (see waivers.ts).
//
// ## Terminals, not names
//
// The naive version of this check asks "does the string `pnpm check:layering` appear in a
// workflow?". That is a false ownership claim waiting to happen: it survives a renamed
// intermediate script, and it cannot see that `pnpm check:tooling` reaches the layering guard
// through two hops. So ownership is modelled as an execution graph resolved down to
// TERMINALS — the actual units of work a command ends up performing:
//
//   vitest:<project>        a Vitest project run
//   node-test:<file>        a `node --test` file (globs are expanded against the real tree)
//   package:<dir>#<script>  a script run inside another workspace package (`pnpm --dir`)
//   exec:<argv>             a script file executed directly, with its positional arguments
//   bin:<name>              an external tool (oxlint, tsc, fallow, …)
//
// A lane (workflow job) owns a terminal when the graph proves the terminal is reachable from
// that job: workflow job → local composite action (with `${{ inputs.* }}` substituted from the
// caller's `with:`) → package script → aggregate script chain → terminal. Positional arguments
// stay in `exec:` terminals precisely so `test:replay:ios` and `test:replay:macos` — both of
// which run src/bin.ts — cannot be confused for one another. Flags are dropped, because a
// `--retries 2` on the CI invocation must not make it a different unit of work than the script.
//
// Anything the walk cannot resolve — a `${{ … }}` in command position, a missing local action,
// a `pnpm <name>` naming no real script, a script whose chain reaches no terminal at all — is
// reported as an unresolved edge naming the exact workflow/job/step, and fails the gate unless
// an explicit waiver classifies it. Reachability is never inferred from a command name merely
// appearing somewhere in the workflow text.

import { parse } from 'yaml';

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
};

type Sink = {
  readonly terminals: Set<Terminal>;
  readonly unresolved: UnresolvedEdge[];
  readonly source: string;
  step: string;
};

// --- Shell reading ----------------------------------------------------------
// Deliberately shallow: this reads the shapes CI actually uses (a few commands per `run:`
// block, joined by newlines and `&&`), and treats everything it does not recognize as
// producing no terminal. "Produces no terminal" can never grant ownership, so an unreadable
// command cannot silently claim a suite is covered — the worst it does is leave the suite
// unowned, which is a failure the gate reports.

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
 * Removes `$(…)` command substitutions and backtick spans. Their contents are values, not the
 * command being run — `APP="$(find "${{ github.workspace }}/…")"` is an assignment, and reading
 * the `${{ … }}` inside it as an unresolved command position would report a dynamic-dispatch
 * edge that is not one. Scans for balanced parentheses so a substitution containing `)` (as in
 * `$(node -p "require('./package.json').version")`) is removed whole.
 */
function stripCommandSubstitutions(run: string): string {
  let out = '';
  for (let index = 0; index < run.length; index++) {
    if (run[index] === '`') {
      const close = run.indexOf('`', index + 1);
      index = close === -1 ? run.length : close;
      continue;
    }
    if (run[index] === '$' && run[index + 1] === '(') {
      let depth = 0;
      let cursor = index + 1;
      for (; cursor < run.length; cursor++) {
        if (run[cursor] === '(') depth++;
        else if (run[cursor] === ')' && --depth === 0) break;
      }
      index = cursor;
      continue;
    }
    out += run[index];
  }
  return out;
}

/** Splits a `run:` block into individual commands on newlines and shell operators. */
function commandSegments(run: string): string[] {
  return stripCommandSubstitutions(stripShellComments(run))
    .replace(/\\\n/g, ' ')
    .split(/\n|&&|\|\||;|\|/)
    .map((segment) => segment.trim())
    .filter(Boolean);
}

function tokenize(segment: string): string[] {
  return segment.split(/\s+/).filter(Boolean);
}

/** `VAR=value` prefixes are environment, not the command; strip them and report what is left. */
function stripEnvPrefix(tokens: readonly string[]): string[] {
  let index = 0;
  while (index < tokens.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[index]!)) index++;
  return tokens.slice(index);
}

function isDynamic(token: string): boolean {
  return token.includes('${{') || token.startsWith('$');
}

const SCRIPT_FILE = /\.(?:[cm]?[jt]s)$|\.sh$/;

/** Shell builtins and inert commands that do no gated work. */
const IGNORED_COMMANDS = new Set([
  'if',
  'then',
  'else',
  'elif',
  'fi',
  'for',
  'do',
  'done',
  'while',
  'case',
  'esac',
  'set',
  'echo',
  'printf',
  'cd',
  'mkdir',
  'rm',
  'cp',
  'mv',
  'ln',
  'cat',
  'test',
  '[',
  'exit',
  'true',
  'false',
  'export',
  'source',
  '.',
  'sleep',
  'touch',
  'chmod',
  'shift',
  'return',
  'local',
  'unset',
  'read',
  'eval',
  'trap',
  'wait',
  'kill',
  'pwd',
  'ls',
  'find',
  'grep',
  'rg',
  'sed',
  'awk',
  'sort',
  'uniq',
  'head',
  'tail',
  'tr',
  'cut',
  'xargs',
  'tee',
  'curl',
  'git',
  'gh',
  'unzip',
  'zip',
  'tar',
  'defaults',
  'xcrun',
  'adb',
  'brew',
  'sudo',
  'apt-get',
  'java',
  'javac',
  'swift',
  'open',
  'killall',
  'plutil',
  'security',
  'softwareupdate',
  'sw_vers',
]);

/** pnpm's own subcommands — these run the package manager, not a repo script. */
const PNPM_SUBCOMMANDS = new Set([
  'install',
  'i',
  'add',
  'remove',
  'rm',
  'update',
  'up',
  'audit',
  'why',
  'list',
  'ls',
  'outdated',
  'pack',
  'publish',
  'prune',
  'rebuild',
  'root',
  'bin',
  'store',
  'link',
  'unlink',
  'import',
  'setup',
  'config',
  'env',
  'licenses',
  'patch',
  'dlx',
  'create',
  'deploy',
  'server',
  'start',
  'test',
  'init',
  'fetch',
  'approve-builds',
]);

/** pnpm flags that redirect the invocation into a different package. */
const PNPM_DIR_FLAGS = new Set([
  '--dir',
  '-C',
  '--filter',
  '--workspace-root',
  '-w',
  '-r',
  '--recursive',
]);

function report(sink: Sink, kind: UnresolvedEdge['kind'], detail: string): void {
  sink.unresolved.push({ source: sink.source, step: sink.step, kind, detail });
}

/**
 * Positional arguments that identify the unit of work: subcommands and repo paths. Flags and
 * their values are dropped so `pnpm test:replay:macos --retries 2` and the bare script resolve
 * to the same terminal, while `bin.ts test <ios-dir>` and `bin.ts test <macos-dir>` stay
 * distinct. Interpolated arguments (`$VERSION`, a leftover `${{ … }}`) are dropped too: they
 * carry no stable identity, so keeping them would make a workflow's invocation of a script
 * spuriously differ from the script's own.
 */
function positionalArgs(tokens: readonly string[]): string[] {
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

/**
 * A `node …` invocation. `--test` turns the remaining path arguments into individual test-file
 * terminals (globs expanded against the tree, so `test/integration/*.test.ts` provably covers
 * `test/integration/smoke-*.test.ts`). A declared transparent wrapper drops out and resolution
 * continues with what it forwards.
 */
function addNodeTerminals(tokens: readonly string[], ctx: ResolveContext, sink: Sink): void {
  const rest = [...tokens];
  let entry: string | undefined;
  while (rest.length > 0) {
    const candidate = rest.shift()!;
    if (candidate.startsWith('-')) {
      // `-p`/`-e` evaluate inline source; there is no gated work to attribute.
      if (
        candidate === '-p' ||
        candidate === '-e' ||
        candidate === '--eval' ||
        candidate === '--print'
      )
        return;
      continue;
    }
    entry = candidate;
    break;
  }
  if (entry === undefined) return;
  if (ctx.transparentWrappers.has(entry)) {
    addNodeTerminals(rest, ctx, sink);
    return;
  }
  if (tokens.includes('--test')) {
    const paths = positionalArgs(rest).filter((arg) => !arg.startsWith('-'));
    // The wrapper case already returned; a `--test` run whose entry is a real file means the
    // entry itself is the first test path.
    for (const pattern of [entry, ...paths]) {
      for (const file of ctx.expandTestPaths(pattern)) sink.terminals.add(`node-test:${file}`);
    }
    return;
  }
  addExecTerminal(entry, rest, ctx, sink);
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

function resolvePnpm(
  tokens: readonly string[],
  ctx: ResolveContext,
  sink: Sink,
  chain: ReadonlySet<string>,
): void {
  const rest = [...tokens];
  let directory: string | null = null;
  while (rest.length > 0 && rest[0]!.startsWith('-')) {
    const flag = rest.shift()!;
    if (!PNPM_DIR_FLAGS.has(flag)) continue;
    if (flag === '--workspace-root' || flag === '-w' || flag === '-r' || flag === '--recursive') {
      directory = directory ?? '(workspace)';
      continue;
    }
    directory = rest.shift() ?? '(unknown)';
  }
  if (rest.length === 0) return;

  let name = rest.shift()!;
  if (name === 'run') {
    if (rest.length === 0) return;
    name = rest.shift()!;
  } else if (name === 'exec') {
    // Everything after `exec` is a plain command again.
    resolveTokens(rest, ctx, sink, chain);
    return;
  } else if (PNPM_SUBCOMMANDS.has(name) || name.startsWith('-')) {
    return;
  }

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
function resolveScript(
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

function resolveTokens(
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
  if (command === 'pnpm') {
    resolvePnpm(rest, ctx, sink, chain);
    return;
  }
  if (command === 'npx' || command === 'bunx') {
    resolveTokens(rest, ctx, sink, chain);
    return;
  }
  if (command === 'node' || command === 'bun') {
    addNodeTerminals(rest, ctx, sink);
    return;
  }
  if (command === 'sh' || command === 'bash' || command === 'zsh') {
    const entry = rest.find((token) => !token.startsWith('-'));
    if (entry === undefined) return;
    if (isDynamic(entry)) {
      report(sink, 'dynamic-command', `shell script path is an unresolved expression: "${entry}"`);
      return;
    }
    addExecTerminal(entry, rest.slice(rest.indexOf(entry) + 1), ctx, sink);
    return;
  }
  if (command === 'vitest') {
    addVitestTerminals(rest, ctx, sink);
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

// --- Workflow model ---------------------------------------------------------

export type WorkflowStep = {
  readonly name: string;
  readonly run?: string;
  readonly uses?: string;
  readonly with: Readonly<Record<string, string>>;
};

export type WorkflowJob = {
  readonly id: string;
  /** The `name:` value, or null when it interpolates an expression (a matrix job). */
  readonly name: string | null;
  readonly steps: readonly WorkflowStep[];
};

export type WorkflowTriggers = {
  readonly events: readonly string[];
  readonly pullRequestPaths?: readonly string[];
  readonly pullRequestPathsIgnore?: readonly string[];
};

export type WorkflowFile = {
  readonly file: string;
  readonly name: string;
  readonly triggers: WorkflowTriggers;
  readonly jobs: readonly WorkflowJob[];
};

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function stringList(value: unknown): string[] | undefined {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === 'string')
    : undefined;
}

function parseSteps(value: unknown): WorkflowStep[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((raw, index) => {
    const step = asRecord(raw);
    if (!step) return [];
    const withInputs: Record<string, string> = {};
    for (const [key, input] of Object.entries(asRecord(step['with']) ?? {})) {
      if (typeof input === 'string') withInputs[key] = input;
    }
    return [
      {
        name: typeof step['name'] === 'string' ? step['name'] : `step ${index + 1}`,
        ...(typeof step['run'] === 'string' ? { run: step['run'] } : {}),
        ...(typeof step['uses'] === 'string' ? { uses: step['uses'] } : {}),
        with: withInputs,
      },
    ];
  });
}

export function parseWorkflow(file: string, source: string): WorkflowFile {
  const document = asRecord(parse(source)) ?? {};
  // `on:` is YAML 1.1's boolean `true` under some parsers; the `yaml` package keeps it a
  // string key, but read both so a parser upgrade cannot silently blank every trigger.
  const on = asRecord(document['on']) ?? asRecord(document[true as unknown as string]) ?? {};
  const pullRequest = asRecord(on['pull_request']);
  const jobs = Object.entries(asRecord(document['jobs']) ?? {}).flatMap(([id, raw]) => {
    const job = asRecord(raw);
    if (!job) return [];
    const name = typeof job['name'] === 'string' ? job['name'] : id;
    return [{ id, name: name.includes('${{') ? null : name, steps: parseSteps(job['steps']) }];
  });
  return {
    file,
    name: typeof document['name'] === 'string' ? document['name'] : file,
    triggers: {
      events: Object.keys(on),
      ...(pullRequest?.['paths'] ? { pullRequestPaths: stringList(pullRequest['paths']) } : {}),
      ...(pullRequest?.['paths-ignore']
        ? { pullRequestPathsIgnore: stringList(pullRequest['paths-ignore']) }
        : {}),
    },
    jobs,
  };
}

/**
 * The status-check names GitHub can show for a job: the bare job name, and the
 * `<workflow> / <job>` form required-context spelling. `CHECK_CATALOG.ciJobs` uses both.
 */
export function jobCheckNames(workflow: WorkflowFile, job: WorkflowJob): string[] {
  return job.name === null ? [] : [job.name, `${workflow.name} / ${job.name}`];
}

export type Lane = {
  readonly workflow: string;
  readonly workflowName: string;
  readonly job: string;
  readonly checkNames: readonly string[];
  /** How the lane is triggered — a suite owned only by a scheduled lane is not a PR gate. */
  readonly kind: 'pull-request' | 'scheduled' | 'release' | 'push';
  readonly terminals: ReadonlySet<Terminal>;
  readonly unresolved: readonly UnresolvedEdge[];
};

function laneKind(triggers: WorkflowTriggers): Lane['kind'] {
  if (triggers.events.includes('pull_request')) return 'pull-request';
  if (triggers.events.includes('schedule') || triggers.events.includes('workflow_dispatch')) {
    return 'scheduled';
  }
  if (triggers.events.includes('release')) return 'release';
  return 'push';
}

/** Substitutes `${{ inputs.x }}` in a composite action step from the caller's `with:` block. */
function substituteInputs(
  run: string,
  callerWith: Readonly<Record<string, string>>,
  defaults: Readonly<Record<string, string>>,
): string {
  return run.replace(/\$\{\{\s*inputs\.([\w-]+)\s*\}\}/g, (match, key: string) => {
    const value = callerWith[key] ?? defaults[key];
    return value === undefined || value.includes('${{') ? match : value;
  });
}

function actionInputDefaults(document: Record<string, unknown>): Record<string, string> {
  const defaults: Record<string, string> = {};
  for (const [key, raw] of Object.entries(asRecord(document['inputs']) ?? {})) {
    const value = asRecord(raw)?.['default'];
    if (typeof value === 'string') defaults[key] = value;
  }
  return defaults;
}

/** Walks one step, descending into local composite actions. `depth` bounds action nesting. */
function resolveStep(step: WorkflowStep, ctx: ResolveContext, sink: Sink, depth: number): void {
  sink.step = step.name;
  if (step.run !== undefined) {
    for (const segment of commandSegments(step.run))
      resolveTokens(tokenize(segment), ctx, sink, new Set());
  }
  if (step.uses === undefined || !step.uses.startsWith('./')) return;
  if (depth > 4) return;
  const actionDir = step.uses.replace(/^\.\//, '');
  const source = ctx.actions.get(actionDir);
  if (source === undefined) {
    report(sink, 'missing-action', `local action "${step.uses}" does not exist`);
    return;
  }
  const document = asRecord(parse(source)) ?? {};
  const defaults = actionInputDefaults(document);
  for (const nested of parseSteps(asRecord(document['runs'])?.['steps'])) {
    const resolved: WorkflowStep =
      nested.run === undefined
        ? nested
        : { ...nested, run: substituteInputs(nested.run, step.with, defaults) };
    resolveStep({ ...resolved, name: `${step.name} → ${nested.name}` }, ctx, sink, depth + 1);
  }
  sink.step = step.name;
}

export function buildLanes(workflows: readonly WorkflowFile[], ctx: ResolveContext): Lane[] {
  const lanes: Lane[] = [];
  for (const workflow of workflows) {
    for (const job of workflow.jobs) {
      const sink: Sink = {
        terminals: new Set(),
        unresolved: [],
        source: `${workflow.file}#${job.id}`,
        step: '(job)',
      };
      for (const step of job.steps) resolveStep(step, ctx, sink, 0);
      lanes.push({
        workflow: workflow.file,
        workflowName: workflow.name,
        job: job.id,
        checkNames: jobCheckNames(workflow, job),
        kind: laneKind(workflow.triggers),
        terminals: sink.terminals,
        unresolved: sink.unresolved,
      });
    }
  }
  return lanes;
}

// --- Suite ownership --------------------------------------------------------

export type Suite = {
  /** `vitest:<project>` or the package script name. */
  readonly id: string;
  readonly kind: 'vitest-project' | 'package-script';
  readonly terminals: ReadonlySet<Terminal>;
  readonly unresolved: readonly UnresolvedEdge[];
};

/**
 * The suite universe, derived rather than listed: every Vitest project, plus every `test:*`
 * and `check:*` package script. Adding either without wiring it to a lane fails the gate.
 */
export function suiteUniverse(ctx: ResolveContext): Suite[] {
  const suites: Suite[] = ctx.vitestProjects.map((project) => ({
    id: `vitest:${project}`,
    kind: 'vitest-project' as const,
    terminals: new Set([`vitest:${project}`]),
    unresolved: [],
  }));
  for (const [name, command] of ctx.packageScripts) {
    if (!/^(?:test|check):/.test(name)) continue;
    suites.push(packageScriptSuite(name, command, ctx));
  }
  return suites.sort((left, right) => left.id.localeCompare(right.id));
}

export function packageScriptSuite(name: string, command: string, ctx: ResolveContext): Suite {
  const sink: Sink = {
    terminals: new Set(),
    unresolved: [],
    source: `package.json#${name}`,
    step: name,
  };
  resolveScript(name, command, ctx, sink);
  if (sink.terminals.size === 0 && sink.unresolved.length === 0) {
    report(sink, 'no-terminal', `script "${name}" resolves to no unit of work`);
  }
  return {
    id: name,
    kind: 'package-script',
    terminals: sink.terminals,
    unresolved: sink.unresolved,
  };
}

export type UnownedTerminal = {
  readonly terminal: Terminal;
  /** Which suites need it — named so the failure says what stops being checked. */
  readonly suites: readonly string[];
};

/**
 * Terminals some suite needs that no lane reaches. Ownership is per terminal rather than per
 * suite so an aggregate script (`check:tooling`, whose parts are spread across five jobs)
 * cannot report as unowned merely because no single job runs all of it.
 */
export function unownedTerminals(
  suites: readonly Suite[],
  lanes: readonly Lane[],
  waived: ReadonlySet<Terminal>,
): UnownedTerminal[] {
  const owned = new Set<Terminal>();
  for (const lane of lanes) for (const terminal of lane.terminals) owned.add(terminal);

  const needed = new Map<Terminal, string[]>();
  for (const suite of suites) {
    for (const terminal of suite.terminals) {
      if (owned.has(terminal) || waived.has(terminal)) continue;
      const holders = needed.get(terminal) ?? [];
      holders.push(suite.id);
      needed.set(terminal, holders);
    }
  }
  return [...needed]
    .map(([terminal, holders]) => ({ terminal, suites: holders.sort() }))
    .sort((left, right) => left.terminal.localeCompare(right.terminal));
}

// --- CHECK_CATALOG wiring ---------------------------------------------------

export type CatalogEntry = {
  readonly id: string;
  readonly script: string | null;
  readonly ciJobs: readonly string[];
};

export type CatalogJobMiss = {
  readonly check: string;
  readonly job: string;
  /** Job names that do exist, for the "naming both sides" failure message. */
  readonly known: readonly string[];
};

/** Catalog entries pointing at a CI job that no workflow defines — the #1429 primary hole. */
export function missingCatalogJobs(
  catalog: readonly CatalogEntry[],
  lanes: readonly Lane[],
): CatalogJobMiss[] {
  const known = new Set(lanes.flatMap((lane) => [...lane.checkNames]));
  const sortedKnown = [...known].sort();
  return catalog.flatMap((entry) =>
    entry.ciJobs
      .filter((job) => !known.has(job))
      .map((job) => ({ check: entry.id, job, known: sortedKnown })),
  );
}

export type CatalogReachabilityMiss = {
  readonly check: string;
  readonly jobs: readonly string[];
  readonly missing: readonly Terminal[];
};

/**
 * A catalog entry claims its script is mirrored by its `ciJobs` — plural, and collectively:
 * `unit` names both Coverage (which runs the Vitest projects) and Integration Tests (which runs
 * the smoke suite), and neither runs the whole script alone. So the claim under test is that
 * the UNION of the named jobs reaches every terminal the script does.
 *
 * This is what makes the catalog's `ciJobs` a checked statement rather than a comment. A
 * renamed intermediate script breaks the chain and surfaces here, instead of leaving the claim
 * standing over work that no longer runs.
 */
export function unreachableCatalogClaims(
  catalog: readonly CatalogEntry[],
  lanes: readonly Lane[],
  ctx: ResolveContext,
  waived: ReadonlySet<string>,
): CatalogReachabilityMiss[] {
  const byName = new Map<string, Lane[]>();
  for (const lane of lanes) {
    for (const name of lane.checkNames) byName.set(name, [...(byName.get(name) ?? []), lane]);
  }
  const misses: CatalogReachabilityMiss[] = [];
  for (const entry of catalog) {
    if (entry.script === null) continue;
    if (waived.has(entry.id)) continue;
    const command = ctx.packageScripts.get(entry.script);
    if (command === undefined) continue; // resolveCommand in checks.ts already fails on this.
    const suite = packageScriptSuite(entry.script, command, ctx);
    const claimed = entry.ciJobs.flatMap((job) => byName.get(job) ?? []);
    if (claimed.length === 0) continue; // missingCatalogJobs reports this.
    const reachable = new Set(claimed.flatMap((lane) => [...lane.terminals]));
    const missing = [...suite.terminals].filter((terminal) => !reachable.has(terminal)).sort();
    if (missing.length > 0) misses.push({ check: entry.id, jobs: entry.ciJobs, missing });
  }
  return misses;
}

// --- Path-category reachability ---------------------------------------------

/** GitHub workflow path filter → RegExp. `**` crosses `/`, `*` and `?` do not. */
export function pathFilterMatches(pattern: string, file: string): boolean {
  const source = pattern.split('').reduce<{ out: string; index: number }>(
    (state, _char, index, chars) => {
      if (index < state.index) return state;
      const rest = chars.slice(index).join('');
      if (rest.startsWith('**/')) return { out: `${state.out}(?:.*/)?`, index: index + 3 };
      if (rest.startsWith('**')) return { out: `${state.out}.*`, index: index + 2 };
      const char = chars[index]!;
      if (char === '*') return { out: `${state.out}[^/]*`, index: index + 1 };
      if (char === '?') return { out: `${state.out}[^/]`, index: index + 1 };
      return { out: state.out + char.replace(/[.+^${}()|[\]\\]/g, '\\$&'), index: index + 1 };
    },
    { out: '', index: 0 },
  ).out;
  return new RegExp(`^${source}$`).test(file);
}

/** Whether a PR touching only `file` would trigger this workflow. */
export function triggersOnPath(triggers: WorkflowTriggers, file: string): boolean {
  if (!triggers.events.includes('pull_request')) return false;
  if (triggers.pullRequestPathsIgnore?.some((pattern) => pathFilterMatches(pattern, file))) {
    return false;
  }
  if (triggers.pullRequestPaths) {
    return triggers.pullRequestPaths.some((pattern) => pathFilterMatches(pattern, file));
  }
  return true;
}

export type PathCategory = {
  /** A representative repo path for the category. */
  readonly path: string;
  readonly label: string;
  /** Check ids the affected-selector routes this path to. */
  readonly checks: readonly string[];
};

export type PathReachabilityMiss = {
  readonly category: string;
  readonly path: string;
  readonly check: string;
  readonly job: string;
  readonly workflow: string;
};

/**
 * The #1420 hole, generalized: a category's owning job must actually fire on a PR that only
 * touches that category. ci.yml's `paths-ignore: website/**` is exactly this failure — the gate
 * exists, the job exists, and the job never runs for the change it is supposed to gate.
 */
export function unreachablePathCategories(
  categories: readonly PathCategory[],
  catalog: readonly CatalogEntry[],
  workflows: readonly WorkflowFile[],
  lanes: readonly Lane[],
  waived: ReadonlySet<string>,
): PathReachabilityMiss[] {
  const byName = new Map<string, Lane[]>();
  for (const lane of lanes) {
    for (const name of lane.checkNames) byName.set(name, [...(byName.get(name) ?? []), lane]);
  }
  const triggersByFile = new Map(workflows.map((workflow) => [workflow.file, workflow.triggers]));
  const misses: PathReachabilityMiss[] = [];

  for (const category of categories) {
    for (const check of category.checks) {
      if (waived.has(`${category.label}@${check}`)) continue;
      const entry = catalog.find((candidate) => candidate.id === check);
      if (!entry) continue;
      const reaching = entry.ciJobs.filter((job) =>
        (byName.get(job) ?? []).some((lane) => {
          const triggers = triggersByFile.get(lane.workflow);
          return triggers !== undefined && triggersOnPath(triggers, category.path);
        }),
      );
      if (reaching.length > 0) continue;
      for (const job of entry.ciJobs) {
        const lane = (byName.get(job) ?? [])[0];
        misses.push({
          category: category.label,
          path: category.path,
          check,
          job,
          workflow: lane?.workflow ?? '(no workflow defines this job)',
        });
      }
    }
  }
  return misses;
}
