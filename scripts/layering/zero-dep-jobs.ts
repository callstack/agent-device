// R8 zero-dep job closure.
//
// Some CI jobs run their scripts straight from a checkout, with
// `install-deps: false` — no `pnpm install`, so no `node_modules`. That makes them fast,
// and it makes them fragile in a way nothing local can feel: every developer machine has
// `node_modules` sitting right there, so a script can grow `import { x } from 'some-package'`
// and keep passing every local run while the job that has no packages fails on the resolve.
//
// That is not hypothetical. The layering guard itself was a zero-dep job until R7 started
// parsing the daemon with `oxc-parser`; `pnpm check:layering` passed locally and CI failed with
// ERR_MODULE_NOT_FOUND. The guard now installs deps, which is the honest fix for it — but the
// contract still binds every job that stays zero-dep, and it should be checkable without
// waiting for the runner to notice.
//
// So: walk each zero-dep job's entry scripts and their whole relative-import closure, and
// require every import to be a Node builtin or another repo file. The zero-dep job list is
// read out of the workflows rather than restated here, so declaring a job zero-dep is what
// puts it under the rule — there is no second place to remember to update.

import { isBuiltin } from 'node:module';
import path from 'node:path';
import { parseSync } from 'oxc-parser';
import { parse } from 'yaml';

/** A CI job that runs without `pnpm install`, plus the scripts it invokes. */
export type ZeroDepJob = {
  workflow: string;
  job: string;
  entries: string[];
};

/** An import a zero-dep job cannot resolve, because nothing installs it. */
export type UninstallableImport = {
  workflow: string;
  job: string;
  file: string;
  line: number;
  spec: string;
};

const SETUP_ACTION = './.github/actions/setup-node-pnpm';

/**
 * Script paths named in a `run:` block. Entries are matched by shape and then confirmed
 * against the tree by the caller, so a shell word that merely looks like a path drops out
 * instead of inventing an entry point.
 */
function runBlockEntries(run: string): string[] {
  return [...run.matchAll(/(?:^|\s)((?:scripts|src|test)\/[\w./@-]+\.(?:ts|mts|js|mjs))/g)].map(
    (match) => match[1]!,
  );
}

/**
 * `pnpm <name>` invocations in a `run:` block. Matched by shape only — the caller resolves
 * each name against package.json's own scripts, so a word that is not a real script (`pnpm
 * install`, `pnpm build`) drops out there rather than here.
 */
function pnpmScriptNames(run: string): string[] {
  return [...run.matchAll(/(?:^|\s)pnpm\s+(?:run\s+)?([\w:.-]+)/g)].map((match) => match[1]!);
}

/**
 * Entry paths reachable from a `run:` block, following `pnpm <name>` aliases into
 * package.json and back into `runBlockEntries` however deep the chain goes — a script
 * that itself runs another named script must not hide that script's entries from R8.
 * `chain` is the set of script names already expanded on this path: an alias that names
 * one of them is a cycle, and is dropped rather than walked again, so a cycle contributes
 * whatever entries its non-cyclic edges found instead of recursing forever.
 */
function resolveRunEntries(
  run: string,
  packageScripts: ReadonlyMap<string, string>,
  fileExists: (file: string) => boolean,
  entries: Set<string>,
  chain: ReadonlySet<string> = new Set(),
): void {
  for (const entry of runBlockEntries(run)) {
    if (fileExists(entry)) entries.add(entry);
  }
  for (const scriptName of pnpmScriptNames(run)) {
    if (chain.has(scriptName)) continue;
    const resolved = packageScripts.get(scriptName);
    if (resolved === undefined) continue;
    resolveRunEntries(
      resolved,
      packageScripts,
      fileExists,
      entries,
      new Set([...chain, scriptName]),
    );
  }
}

function stepsOf(job: unknown): Record<string, unknown>[] {
  if (job === null || typeof job !== 'object') return [];
  const steps = (job as Record<string, unknown>)['steps'];
  return Array.isArray(steps)
    ? steps.filter((step) => step !== null && typeof step === 'object')
    : [];
}

function skipsInstall(step: Record<string, unknown>): boolean {
  if (step['uses'] !== SETUP_ACTION) return false;
  const withInputs = step['with'];
  if (withInputs === null || typeof withInputs !== 'object') return false;
  // YAML `false` parses to a boolean; a quoted 'false' stays a string. The action compares
  // the input against the string 'true', so both spellings mean "do not install".
  const installDeps = (withInputs as Record<string, unknown>)['install-deps'];
  return installDeps === false || installDeps === 'false';
}

/**
 * Every job across `workflows` that sets `install-deps: false`, with the entry scripts its
 * steps invoke. `fileExists` filters candidate paths down to files that are really there.
 *
 * `packageScripts` resolves a bare `pnpm <name>` invocation back to the command string
 * package.json names it, so a zero-dep job may call its script by its pnpm name — R8 reads
 * the same entry paths out of the resolved command rather than requiring the literal path
 * inline in the workflow. A `pnpm` word that names no real script (`pnpm install`) resolves
 * to nothing and is silently ignored, same as a shell word that merely looks like a path.
 * Resolution recurses through chained aliases (a script that itself runs another named
 * script), so a nested entry is never invisible to the closure just because it is one hop
 * further away; a cycle in that chain stops re-expanding the repeated name rather than
 * recursing forever.
 */
export function zeroDepJobs(
  workflows: ReadonlyMap<string, string>,
  fileExists: (file: string) => boolean,
  packageScripts: ReadonlyMap<string, string> = new Map(),
): ZeroDepJob[] {
  const jobs: ZeroDepJob[] = [];
  for (const [workflow, source] of workflows) {
    const document = parse(source) as Record<string, unknown> | null;
    const workflowJobs = document?.['jobs'];
    if (workflowJobs === null || typeof workflowJobs !== 'object') continue;

    for (const [job, definition] of Object.entries(workflowJobs as Record<string, unknown>)) {
      const steps = stepsOf(definition);
      if (!steps.some(skipsInstall)) continue;
      const entries = new Set<string>();
      for (const step of steps) {
        const run = step['run'];
        if (typeof run !== 'string') continue;
        resolveRunEntries(run, packageScripts, fileExists, entries);
      }
      jobs.push({ workflow, job, entries: [...entries].sort() });
    }
  }
  return jobs.sort(
    (left, right) =>
      left.workflow.localeCompare(right.workflow) || left.job.localeCompare(right.job),
  );
}

type Specifier = { spec: string; line: number };

function lineOf(source: string, offset: number): number {
  let line = 1;
  for (let index = 0; index < offset && index < source.length; index++) {
    if (source[index] === '\n') line++;
  }
  return line;
}

/**
 * Every module specifier a file requests, static or dynamic, read out of `oxc-parser`'s module
 * record rather than scanned line by line. The distinction matters here more than anywhere else
 * in this directory: a zero-dep job runs `--test` files, and a test that pins import behaviour
 * naturally contains `"import x from 'some-package'"` as a *string*. A line scanner reads that
 * as an import and reports a violation that does not exist, which is how a gate stops being
 * trusted. The parser sees a string literal.
 */
function moduleSpecifiers(file: string, source: string): Specifier[] {
  const record = parseSync(file, source).module;
  const specifiers: Specifier[] = [];

  const push = (request: { value?: string; start?: number } | undefined): void => {
    if (!request?.value) return;
    specifiers.push({ spec: request.value, line: lineOf(source, request.start ?? 0) });
  };

  for (const entry of record.staticImports) push(entry.moduleRequest);
  for (const entry of record.staticExports) {
    // `export … from` carries the specifier per entry; a plain `export { x }` has none.
    for (const exported of entry.entries) push(exported.moduleRequest);
  }
  for (const entry of record.dynamicImports) {
    // Dynamic imports report a span, not a value, because the argument need not be a literal.
    const raw = source.slice(entry.moduleRequest.start, entry.moduleRequest.end);
    const literal = /^(['"])([^'"]*)\1$/.exec(raw);
    if (literal) {
      specifiers.push({ spec: literal[2]!, line: lineOf(source, entry.moduleRequest.start) });
    }
  }

  return specifiers;
}

function resolveRelative(
  fromFile: string,
  spec: string,
  fileExists: (file: string) => boolean,
): string | null {
  const base = path.posix.normalize(path.posix.join(path.posix.dirname(fromFile), spec));
  const candidates = [
    base,
    base.replace(/\.js$/, '.ts'),
    `${base}.ts`,
    path.posix.join(base, 'index.ts'),
  ];
  return candidates.find(fileExists) ?? null;
}

/**
 * Every import in a zero-dep job's transitive closure that a checkout without `node_modules`
 * cannot resolve. Builtins (with or without the `node:` prefix) are fine; so is any relative
 * import that lands on a repo file. Anything else is a package, and the job has no packages.
 *
 * A relative import that resolves to nothing is left alone — that is a broken import, which
 * typecheck reports far better than this can.
 */
export function uninstallableImports(
  job: ZeroDepJob,
  readSource: (file: string) => string | null,
  fileExists: (file: string) => boolean,
): UninstallableImport[] {
  const found: UninstallableImport[] = [];
  const visited = new Set<string>();
  const queue = [...job.entries];

  while (queue.length > 0) {
    const file = queue.shift()!;
    if (visited.has(file)) continue;
    visited.add(file);
    const source = readSource(file);
    if (source === null) continue;

    for (const { spec, line } of moduleSpecifiers(file, source)) {
      if (spec.startsWith('.')) {
        const target = resolveRelative(file, spec, fileExists);
        if (target) queue.push(target);
        continue;
      }
      if (isBuiltin(spec)) continue;
      found.push({ workflow: job.workflow, job: job.job, file, line, spec });
    }
  }

  return found.sort((left, right) => left.file.localeCompare(right.file) || left.line - right.line);
}
