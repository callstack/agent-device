// Import-direction lint — enforces the folder DAG established by the Phase-5
// folder moves (see CONTEXT.md, "Architecture: folder DAG + layering lint").
//
// Ranked target spine, as rank groups lowest (kernel sink) to highest. `A ◄ B` means B may not
// be outranked by A (the back-edge order the gate rejects), NOT that every displayed import exists:
//   kernel ◄ { contracts, request, selectors, platforms } ◄ core ◄ { commands, cli-schema }
//         ◄ { client, daemon-server } ◄ daemon-client ◄ cli
// (authoritative ranks: `TARGET_DAG_RANK` in model.ts)
//
// This gate enforces five things, across four scopes:
//   - GLOBALLY, across every production source file: the R1-R3 move rules and
//     rejection of all production static value-import cycles (R4).
//   - Over the RANKED SPINE only: rejection of every spine back-edge (R5), i.e.
//     an import whose source zone outranks its target zone, plus a ratchet on the
//     same inversion measured over TYPE-ONLY edges (R6).
//   - Over the DAEMON only: SessionState field ownership (R7), because the session
//     record is store-owned mutable state that any daemon module can write.
//   - Over the ZERO-DEP CI JOBS only: their scripts may import nothing that needs
//     installing (R8), a constraint no local run can feel because `node_modules` is
//     always there locally and never there in those jobs.
// Only `(root)` is unranked (see `UNRANKED_ZONES` in model.ts): it holds the
// entrypoints and the composition roots that wire the command surface into the
// daemon, which R2 forbids the daemon from importing, so they sit outside the
// spine by construction. Every other zone is ranked.

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  fieldClassificationDrift,
  findSessionStateWrites,
  sessionStateFields,
  SESSION_STATE_FIELD_OWNERS,
  STORE_OWNED_SESSION_STATE_FIELDS,
} from './session-state.ts';
import { uninstallableImports, zeroDepJobs } from './zero-dep-jobs.ts';
import {
  backEdgePair,
  findValueImportCycles,
  resolveImportEdges,
  topFolder,
  typeInversionPair,
  type ImportEdge,
  type ResolvedImportEdge,
} from './model.ts';

type EdgeContext = {
  file: string;
  fromTop: string;
  toTop: string;
  imp: ImportEdge;
};

type Violation = {
  rule: string;
  file: string;
  line: number;
  message: string;
};

const repoRoot = execFileSync('git', ['rev-parse', '--show-toplevel'], {
  encoding: 'utf8',
}).trim();

export function listSourceFiles(): string[] {
  // `src/**/*.ts` only matches nested files; root-level `src/*.ts` (e.g.
  // src/cli.ts, src/command-catalog.ts) needs its own pathspec or it silently
  // drops out of cycle/back-edge analysis.
  const out = execFileSync('git', ['ls-files', 'src/*.ts', 'src/**/*.ts'], {
    cwd: repoRoot,
    encoding: 'utf8',
  });
  return out.split('\n').filter(Boolean).filter(isProductionSourceFile);
}

function readSources(files: readonly string[]): Map<string, string> {
  return new Map(files.map((file) => [file, fs.readFileSync(path.join(repoRoot, file), 'utf8')]));
}

function fileExists(file: string): boolean {
  return fs.existsSync(path.join(repoRoot, file)) && fs.statSync(path.join(repoRoot, file)).isFile();
}

function readSourceOrNull(file: string): string | null {
  return fileExists(file) ? fs.readFileSync(path.join(repoRoot, file), 'utf8') : null;
}

function isProductionSourceFile(file: string): boolean {
  return file.endsWith('.ts') && !/(?:^|\/)__tests__\//.test(file) && !/\.test\.ts$/.test(file);
}

function isCoreInteractor(file: string): boolean {
  return file.startsWith('src/core/interactors/');
}

function isDaemonServer(file: string): boolean {
  return file.startsWith('src/daemon/') && !file.startsWith('src/daemon/client/');
}

function isSdkBarrel(file: string): boolean {
  return file.startsWith('src/sdk/');
}

function ruleKernelSink(ctx: EdgeContext): Violation | null {
  if (ctx.fromTop !== 'kernel') return null;
  if (ctx.toTop === 'contracts' && ctx.imp.typeOnly) return null;
  return {
    rule: 'R1 kernel-sink',
    file: ctx.file,
    line: ctx.imp.line,
    message:
      `kernel must not import ${ctx.toTop}/ (imports '${ctx.imp.spec}'). ` +
      `The only allowed kernel out-edge is a type-only re-export from contracts/.`,
  };
}

const BELOW_COMMANDS = new Set(['kernel', 'platforms', 'core', 'daemon']);

function ruleCommandsFloor(ctx: EdgeContext): Violation | null {
  if (ctx.toTop !== 'commands' || !BELOW_COMMANDS.has(ctx.fromTop)) return null;
  return {
    rule: 'R2 commands-floor',
    file: ctx.file,
    line: ctx.imp.line,
    message:
      `${ctx.fromTop}/ must not import the command surface commands/ ` +
      `(imports '${ctx.imp.spec}'). Depend on shared kernel/contracts instead.`,
  };
}

function rulePlatformsSeam(ctx: EdgeContext): Violation | null {
  if (ctx.toTop !== 'platforms' || ctx.imp.dynamic || ctx.imp.typeOnly) return null;
  if (isCoreInteractor(ctx.file) || isDaemonServer(ctx.file) || isSdkBarrel(ctx.file)) return null;
  return {
    rule: 'R3 platforms-seam',
    file: ctx.file,
    line: ctx.imp.line,
    message:
      `static value import of platforms/ from ${ctx.fromTop}/ (imports '${ctx.imp.spec}'). ` +
      `Only src/core/interactors/ and the daemon server may statically import platforms/; ` +
      `elsewhere use a dynamic import() or a type-only import to preserve CLI cold-start.`,
  };
}

const RULES = [ruleKernelSink, ruleCommandsFloor, rulePlatformsSeam];

function checkLayeringRules(edges: readonly ResolvedImportEdge[]): Violation[] {
  const violations: Violation[] = [];
  for (const edge of edges) {
    const fromTop = topFolder(edge.file);
    const toTop = topFolder(edge.target);
    if (fromTop === toTop) continue;
    const ctx: EdgeContext = { file: edge.file, fromTop, toTop, imp: edge };
    for (const rule of RULES) {
      const violation = rule(ctx);
      if (violation) violations.push(violation);
    }
  }
  return violations;
}

function checkCycles(edges: readonly ResolvedImportEdge[]): Violation[] {
  return findValueImportCycles(edges).map((cycle) => ({
    rule: 'R4 value-import-cycle',
    file: cycle[0]!,
    line: 1,
    message: `production value-import cycle: ${cycle.join(' -> ')}`,
  }));
}

function checkBackEdges(edges: readonly ResolvedImportEdge[]): Violation[] {
  const seen = new Set<string>();
  return edges.flatMap((edge) => {
    const pair = backEdgePair(edge);
    const identity = `${edge.file} -> ${edge.target}`;
    if (!pair || seen.has(identity)) return [];
    seen.add(identity);
    return [
      {
        rule: 'R5 zero-back-edges',
        file: edge.file,
        line: edge.line,
        message: `${pair} back-edge: ${identity}. Move the shared contract below both owners.`,
      },
    ];
  });
}

// R6 ratchet: type-only spine inversions, per zone pair. R5 cannot see these (a
// type-only import is free at runtime), but "zone A is declared in terms of zone B"
// is still a boundary claim, and ranking type edges surfaced 61 of them. Two clusters
// remain, each needing its own change rather than a file move:
//
//   commands/contracts/mcp        the per-command Options/Result vocabulary, plus the client
//     -> client                   facade itself, are declared inside the 1.2k-line public
//                                 Node-client surface (client/client-types.ts) instead of in
//                                 contracts/, where the 24 types it already re-exports live.
//   core/commands -> daemon-server the ADR 0003 daemon facet: core's descriptor registry
//                                  composes a shape the daemon owns. The daemon keeps the
//                                  VALUES; only the shape needs to move below core.
//   replay -> daemon-server        `SessionAction`, the recorded-action shape replay reads and
//                                  writes. It belongs in contracts/, but it references
//                                  `CommandFlags` (core) which references `DaemonBatchStep`
//                                  (core), so it moves as a chain of three, not one file.
//
// The counts may only go DOWN. Fixing edges without lowering the number fails too, so the
// baseline cannot quietly stop describing the tree.
const TYPE_INVERSION_BASELINE: Readonly<Record<string, number>> = {
  'commands -> client': 28,
  'commands -> daemon-server': 1,
  'contracts -> client': 1,
  'core -> daemon-server': 5,
  'mcp -> client': 1,
  'replay -> daemon-server': 6,
};

function checkTypeInversions(edges: readonly ResolvedImportEdge[]): Violation[] {
  const seen = new Set<string>();
  const countsByPair = new Map<string, number>();
  const firstEdgeByPair = new Map<string, ResolvedImportEdge>();
  for (const edge of edges) {
    const pair = typeInversionPair(edge);
    if (!pair) continue;
    const identity = `${edge.file} -> ${edge.target}`;
    if (seen.has(identity)) continue;
    seen.add(identity);
    countsByPair.set(pair, (countsByPair.get(pair) ?? 0) + 1);
    if (!firstEdgeByPair.has(pair)) firstEdgeByPair.set(pair, edge);
  }

  const violations: Violation[] = [];
  for (const [pair, count] of [...countsByPair].sort(([left], [right]) =>
    left.localeCompare(right),
  )) {
    const allowed = TYPE_INVERSION_BASELINE[pair];
    const edge = firstEdgeByPair.get(pair)!;
    if (allowed === undefined) {
      violations.push({
        rule: 'R6 type-spine-inversion',
        file: edge.file,
        line: edge.line,
        message:
          `new type-only ${pair} inversion (${count} edge(s), e.g. ${edge.file} -> ${edge.target}). ` +
          `Declare the shared type below both zones instead of adding it to TYPE_INVERSION_BASELINE.`,
      });
      continue;
    }
    if (count > allowed) {
      violations.push({
        rule: 'R6 type-spine-inversion',
        file: edge.file,
        line: edge.line,
        message:
          `type-only ${pair} inversions grew to ${count} (baseline ${allowed}). ` +
          `Move the shared type below both zones; the baseline may only shrink.`,
      });
    }
  }

  for (const [pair, allowed] of Object.entries(TYPE_INVERSION_BASELINE)) {
    const count = countsByPair.get(pair) ?? 0;
    if (count >= allowed) continue;
    const message =
      count === 0
        ? `type-only ${pair} inversions are all gone — delete this entry from TYPE_INVERSION_BASELINE.`
        : `type-only ${pair} inversions dropped to ${count} — lower TYPE_INVERSION_BASELINE to ${count}.`;
    violations.push({
      rule: 'R6 type-spine-inversion',
      file: 'scripts/layering/check.ts',
      line: 1,
      message,
    });
  }
  return violations;
}

function checkSessionStateOwnership(sources: ReadonlyMap<string, string>): Violation[] {
  const types = sources.get('src/daemon/types.ts');
  if (!types) {
    return [
      {
        rule: 'R7 session-state-ownership',
        file: 'src/daemon/types.ts',
        line: 1,
        message: 'daemon/types.ts is missing, so SessionState ownership cannot be checked.',
      },
    ];
  }

  const fields = sessionStateFields(types);
  const writes = findSessionStateWrites(sources, fields);
  const violations: Violation[] = [];
  const seenOwners = new Map<string, Set<string>>();

  // Parity first: the rule is only exhaustive if every declared field is classified. A field
  // that is in neither table would otherwise pass by being invisible to the scan, and R7 would
  // quietly stop covering part of the type it claims to cover.
  const DRIFT_MESSAGE: Readonly<Record<string, string>> = {
    unclassified:
      'is declared by SessionState but classified nowhere. Name its owning module in ' +
      'SESSION_STATE_FIELD_OWNERS, or — if the store establishes it at construction and nothing ' +
      'mutates it later — add it to STORE_OWNED_SESSION_STATE_FIELDS.',
    both:
      'is in both SESSION_STATE_FIELD_OWNERS and STORE_OWNED_SESSION_STATE_FIELDS. A field is ' +
      'either store-established or owned by a writer, not both.',
    'not-a-field':
      'is classified but is no longer declared by SessionState — remove it from the table it ' +
      'still appears in.',
  };
  for (const { field, problem } of fieldClassificationDrift(fields)) {
    violations.push({
      rule: 'R7 session-state-ownership',
      file: 'scripts/layering/session-state.ts',
      line: 1,
      message: `session.${field} ${DRIFT_MESSAGE[problem]}`,
    });
  }

  for (const write of writes) {
    const owners = SESSION_STATE_FIELD_OWNERS[write.field];
    const seen = seenOwners.get(write.field) ?? new Set<string>();
    seen.add(write.file);
    seenOwners.set(write.field, seen);
    if (write.field === '[computed]') {
      violations.push({
        rule: 'R7 session-state-ownership',
        file: write.file,
        line: write.line,
        message:
          'computed write to a session field (`session[key] = …`). The field cannot be ' +
          'attributed to an owner, so write the field by name, or move the write into the ' +
          'module that owns the fields it can reach.',
      });
      continue;
    }
    if (owners === undefined) {
      const storeOwned = STORE_OWNED_SESSION_STATE_FIELDS.has(write.field);
      violations.push({
        rule: 'R7 session-state-ownership',
        file: write.file,
        line: write.line,
        message: storeOwned
          ? `session.${write.field} is classified store-established ` +
            `(STORE_OWNED_SESSION_STATE_FIELDS), meaning nothing mutates it after construction — ` +
            `but this is a direct write. Route it through the store, or move the field into ` +
            `SESSION_STATE_FIELD_OWNERS with this module as its owner.`
          : `session.${write.field} has no declared owner. SessionStore hands out the live ` +
            `record, so this write is durable: name the owning module in ` +
            `SESSION_STATE_FIELD_OWNERS (scripts/layering/session-state.ts).`,
      });
      continue;
    }
    if (!owners.includes(write.file)) {
      violations.push({
        rule: 'R7 session-state-ownership',
        file: write.file,
        line: write.line,
        message:
          `session.${write.field} is owned by ${owners.join(', ')}. Call the owner instead of ` +
          `writing the field here, so whatever invariant it carries stays in one place.`,
      });
    }
  }

  // An owner that no longer writes its field is stale documentation; drop it so the table
  // keeps describing the tree rather than a past version of it.
  for (const [field, owners] of Object.entries(SESSION_STATE_FIELD_OWNERS)) {
    const actual = seenOwners.get(field) ?? new Set<string>();
    const stale = owners.filter((owner) => !actual.has(owner)).sort();
    if (stale.length === 0) continue;
    violations.push({
      rule: 'R7 session-state-ownership',
      file: 'scripts/layering/session-state.ts',
      line: 1,
      message:
        `session.${field} is no longer written by ${stale.join(', ')} — remove ` +
        `${stale.length === owners.length ? 'the entry' : 'those owners'} from ` +
        `SESSION_STATE_FIELD_OWNERS.`,
    });
  }
  return violations;
}

// R8: a CI job that runs with `install-deps: false` has no `node_modules`, so every script it
// reaches must import only Node builtins and other repo files. Locally the opposite is true —
// `node_modules` is always present — which is why this needs a gate rather than a convention.
function checkZeroDepJobs(): Violation[] {
  const workflows = readSources(
    execFileSync('git', ['ls-files', '.github/workflows/*.yml'], { cwd: repoRoot, encoding: 'utf8' })
      .split('\n')
      .filter(Boolean),
  );

  const violations: Violation[] = [];
  for (const job of zeroDepJobs(workflows, fileExists)) {
    // Fail closed: a zero-dep job whose commands the entry scan cannot recognize would
    // otherwise be silently exempt from the rule it is the whole reason for.
    if (job.entries.length === 0) {
      violations.push({
        rule: 'R8 zero-dep-job-closure',
        file: job.workflow,
        line: 1,
        message:
          `job '${job.job}' runs with install-deps: false but no entry script was found in its ` +
          `run steps, so its import closure cannot be checked. Invoke the script by path, or ` +
          `let the job install dependencies.`,
      });
      continue;
    }
    for (const bare of uninstallableImports(job, readSourceOrNull, fileExists)) {
      violations.push({
        rule: 'R8 zero-dep-job-closure',
        file: bare.file,
        line: bare.line,
        message:
          `'${bare.spec}' is a package, and job '${bare.job}' (${bare.workflow}) runs with ` +
          `install-deps: false — nothing installs it, so this resolves locally and fails in CI. ` +
          `Use a Node builtin, inline what you need, or drop install-deps: false from the job.`,
      });
    }
  }
  return violations;
}

function sessionStateFieldCount(): number {
  return (
    Object.keys(SESSION_STATE_FIELD_OWNERS).length + STORE_OWNED_SESSION_STATE_FIELDS.size
  );
}

function report(files: readonly string[], violations: readonly Violation[]): number {
  if (violations.length === 0) {
    process.stdout.write(
      `Layering guard: OK — ${files.length} source files satisfy R1-R3 and contain no ` +
        `value-import cycles (both checked globally); the ranked target spine contains no ` +
        `back-edges (only the composition root is unranked), and its type-only ` +
        `inversions match the R6 ratchet (${Object.values(TYPE_INVERSION_BASELINE).reduce((sum, count) => sum + count, 0)} remaining); ` +
        `all ${sessionStateFieldCount()} SessionState fields are classified and every write is ` +
        `inside its declared owner (R7); and every zero-dep CI job resolves without ` +
        `node_modules (R8).\n`,
    );
    return 0;
  }

  const byRule = new Map<string, Violation[]>();
  for (const violation of violations) {
    const group = byRule.get(violation.rule) ?? [];
    group.push(violation);
    byRule.set(violation.rule, group);
  }

  process.stderr.write(`Layering guard: ${violations.length} violation(s)\n\n`);
  for (const [rule, group] of byRule) {
    process.stderr.write(`  [${rule}] ${group.length} violation(s):\n`);
    for (const violation of group) {
      process.stderr.write(`    ${violation.file}:${violation.line} — ${violation.message}\n`);
      process.stderr.write(
        `::error file=${violation.file},line=${violation.line},title=Layering drift (${violation.rule})::${violation.message}\n`,
      );
    }
    process.stderr.write('\n');
  }
  return 1;
}

export function main(): number {
  const sourceFiles = listSourceFiles();
  const sources = readSources(sourceFiles);
  const edges = resolveImportEdges(sources);
  const violations = [
    ...checkLayeringRules(edges),
    ...checkCycles(edges),
    ...checkBackEdges(edges),
    ...checkTypeInversions(edges),
    ...checkSessionStateOwnership(sources),
    ...checkZeroDepJobs(),
  ];
  return report(sourceFiles, violations);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  process.exit(main());
}
