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
//   - Over the TYPE GRAPH: the largest type-level import cycle may not grow (R9). R4
//     keeps the value graph acyclic, so these cycles are free at runtime but bound
//     what can be read in isolation. Growth-only, deliberately loose.
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
  largestTypeCycleSize,
  resolveImportEdges,
  topFolder,
  typeInversionPair,
  type ResolvedImportEdge,
} from './model.ts';
import { policyLead, policyViolation, ZONE_POLICIES } from './zone-policy.ts';

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
  return (
    fs.existsSync(path.join(repoRoot, file)) && fs.statSync(path.join(repoRoot, file)).isFile()
  );
}

function readSourceOrNull(file: string): string | null {
  return fileExists(file) ? fs.readFileSync(path.join(repoRoot, file), 'utf8') : null;
}

function isProductionSourceFile(file: string): boolean {
  return file.endsWith('.ts') && !/(?:^|\/)__tests__\//.test(file) && !/\.test\.ts$/.test(file);
}

// R1-R3 are declared as a policy table in zone-policy.ts. This walks it; the boundaries
// themselves are data, so adding one is a table entry rather than a fourth predicate.
function checkLayeringRules(edges: readonly ResolvedImportEdge[]): Violation[] {
  const violations: Violation[] = [];
  for (const edge of edges) {
    const fromZone = topFolder(edge.file);
    const toZone = topFolder(edge.target);
    if (fromZone === toZone) continue;
    const ctx = { file: edge.file, fromZone, toZone, imp: edge };
    for (const policy of ZONE_POLICIES) {
      const hint = policyViolation(policy, ctx);
      if (hint === null) continue;
      violations.push({
        rule: policy.rule,
        file: edge.file,
        line: edge.line,
        message: `${policyLead(ctx)} ${hint}`,
      });
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

// R6 ratchet: type-only spine inversions, per zone pair. R5 cannot see these (a type-only import
// is free at runtime), but "zone A is declared in terms of zone B" is still a boundary claim, and
// ranking type edges surfaced 61 of them. Down to 7, and every one of the 7 is now a deliberate
// architectural position rather than a misplaced declaration:
//
//   commands/mcp -> client (4)   `AgentDeviceClient`, used as an opaque handle ("the client this
//                                command runs against"). It cannot move below `commands/` because
//                                the facade is BUILT from the command surface's own projection
//                                registry: AgentDeviceClient -> AgentDeviceCommandClient ->
//                                ProjectedNavigationCommandClient -> NAVIGATION_COMMAND_PROJECTIONS
//                                in commands/system/. That is a genuine zone-level cycle, and
//                                breaking it means deciding where the projection registry belongs —
//                                a design call, not a file move. R5 is zero here: nothing imports
//                                the client at runtime, only its type.
//
//   core -> daemon-server (2)    `DaemonCommandDescriptor`, which is STATED IN TERMS OF the daemon's
//                                own server-private `DaemonRequest` (`refFrameEffect`,
//                                `allowSessionlessDefaultDevice`, `skipSessionlessProviderDevice`
//                                are all `(req: DaemonRequest) => …`). It therefore cannot be
//                                declared below the daemon, and having core/ re-declare a parallel
//                                13-field shape would trade one erased edge for a second source of
//                                truth. Zones that only need to CLASSIFY a command take
//                                `contracts/dispatched-command.ts` instead. ADR 0003/0008.
//
//   commands -> daemon-server (1)  `DaemonCommandRoute` = `keyof typeof DAEMON_ROUTE_HANDLERS`, so
//                                it is COMPUTED FROM the daemon's handler table and cannot exist
//                                below it. `commands/command-explain.ts` uses it to key an
//                                exhaustive `Record<DaemonCommandRoute, string>` of owner files; a
//                                hand-written union in contracts/ would drop that exhaustiveness.
//
// See docs/dependency-graph-findings.md §0 for the long form. The counts may only go DOWN. Fixing edges without lowering the number fails too, so the baseline
// cannot quietly stop describing the tree.
//
// Exported so scripts/depgraph can assert its own graph build reproduces it — see the
// baseline-parity test there. The gate remains the authority; the report follows.
export const TYPE_INVERSION_BASELINE: Readonly<Record<string, number>> = {
  'commands -> client': 3,
  'commands -> daemon-server': 1,
  'core -> daemon-server': 2,
  'mcp -> client': 1,
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

// R9: the largest type-level import cycle, ratcheted for GROWTH ONLY.
//
// R4 keeps the value graph acyclic, so every cycle counted here is created by type-only imports.
// That is free at runtime and invisible to R5/R6, but it bounds what can be read in isolation:
// inside a strongly-connected component of 102 files, no file has a self-contained slice — reading
// any one of them means reaching every other one's declarations. It is the largest single obstacle
// to understanding a subsystem on its own, and nothing else in this gate measures it.
//
// Deliberately loose. Unlike R6 this does NOT fail when the number drops, because the number is
// large and reducing it is a real refactor rather than a file move — a hard equality would turn
// every unrelated improvement into a baseline edit. It fails only on growth, and reports the slack
// when the tree has improved so the baseline can be lowered when someone is in here anyway.
//
// Hubs at the time of writing, by in-component dependents: runtime-contract.ts (25),
// commands/runtime-types.ts (21), backend.ts (15), commands/runtime-common.ts (12). A pass at this
// starts there. See docs/dependency-graph-findings.md.
// Set to what THIS branch achieves, not to what main carries: main is at 107, and the boundary
// moves here bring it to 102. Measured on the rebased tree — an earlier 87 was taken against an
// older main and was stale rather than violated, which is exactly the kind of drift a ratchet
// measured at merge time prevents.
export const TYPE_CYCLE_BASELINE = 102;

function checkTypeCycleGrowth(actual: number): Violation[] {
  if (actual <= TYPE_CYCLE_BASELINE) return [];
  return [
    {
      rule: 'R9 type-cycle-growth',
      file: 'scripts/layering/check.ts',
      line: 1,
      message:
        `the largest type-level import cycle grew to ${actual} files (baseline ` +
        `${TYPE_CYCLE_BASELINE}). A type-only import that closes a loop makes every file in the ` +
        `loop unreadable in isolation. Declare the shared type below both modules, or if the growth ` +
        `is genuinely warranted, raise TYPE_CYCLE_BASELINE in the same commit and say why.`,
    },
  ];
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
    execFileSync('git', ['ls-files', '.github/workflows/*.yml'], {
      cwd: repoRoot,
      encoding: 'utf8',
    })
      .split('\n')
      .filter(Boolean),
  );
  const packageJson = JSON.parse(fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf8')) as {
    scripts?: Record<string, string>;
  };
  const packageScripts = new Map(Object.entries(packageJson.scripts ?? {}));

  const violations: Violation[] = [];
  for (const job of zeroDepJobs(workflows, fileExists, packageScripts)) {
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
  return Object.keys(SESSION_STATE_FIELD_OWNERS).length + STORE_OWNED_SESSION_STATE_FIELDS.size;
}

/** R9 is growth-only, so a shrunk tree is reported rather than failed — see checkTypeCycleGrowth. */
function typeCycleNote(actual: number): string {
  if (actual >= TYPE_CYCLE_BASELINE) return `the largest type-level cycle is ${actual} files (R9)`;
  return (
    `the largest type-level cycle is down to ${actual} files, under the R9 baseline of ` +
    `${TYPE_CYCLE_BASELINE} — lower TYPE_CYCLE_BASELINE when convenient`
  );
}

function report(
  files: readonly string[],
  violations: readonly Violation[],
  typeCycle: number,
): number {
  if (violations.length === 0) {
    process.stdout.write(
      `Layering guard: OK — ${files.length} source files satisfy R1-R3 and contain no ` +
        `value-import cycles (both checked globally); the ranked target spine contains no ` +
        `back-edges (only the composition root is unranked), and its type-only ` +
        `inversions match the R6 ratchet (${Object.values(TYPE_INVERSION_BASELINE).reduce((sum, count) => sum + count, 0)} remaining); ` +
        `all ${sessionStateFieldCount()} SessionState fields are classified and every write is ` +
        `inside its declared owner (R7); every zero-dep CI job resolves without ` +
        `node_modules (R8); and ${typeCycleNote(typeCycle)}.\n`,
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
  // Computed once and threaded: the rule and the success line must report the same number.
  const typeCycle = largestTypeCycleSize(edges);
  const violations = [
    ...checkLayeringRules(edges),
    ...checkCycles(edges),
    ...checkBackEdges(edges),
    ...checkTypeInversions(edges),
    ...checkSessionStateOwnership(sources),
    ...checkTypeCycleGrowth(typeCycle),
    ...checkZeroDepJobs(),
  ];
  return report(sourceFiles, violations, typeCycle);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  process.exit(main());
}
