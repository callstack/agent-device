// `pnpm depgraph affected <path>` — the blast radius of one file in one query.
//
//   pnpm depgraph affected src/utils/exec.ts
//   pnpm depgraph affected src/daemon/ref-frame.ts --json --limit 20
//
// Answers, from the sources of truth rather than a second copy of them:
//   - dependents (direct / transitive, with a zone breakdown) — reverse reachability over the
//     layering gate's own value-edge graph (scripts/depgraph/model.ts);
//   - the gates that dependent set selects — `scripts/check-affected/model.ts`, the same
//     selector `pnpm check:affected` runs, so the two cannot disagree;
//   - the live iOS simulator scenarios that claim the public commands whose handler chain
//     reaches the file — the coverage manifest, when it is present in the tree;
//   - the ADR 0011 guarantee-matrix cells the file implements.
//
// Output is bounded on purpose (lists cut to `--limit` with an explicit "+N more"): the reader
// is usually an agent about to spend its context on the edit itself. `--json` is unbounded.

import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { PUBLIC_COMMANDS } from '../../src/command-catalog.ts';
import {
  INTERACTION_DISPATCH_PATHS,
  type InteractionPathId,
} from '../../src/contracts/interaction-guarantees.ts';
import { DAEMON_COMMAND_DESCRIPTORS } from '../../src/daemon/daemon-command-registry.ts';
import { parseArgs } from 'node:util';
import { selectChecks, type CheckPlan } from '../check-affected/model.ts';
import {
  bound,
  collectDependents,
  commandsReaching,
  formatBounded,
  guaranteeRowsForFile,
  rankByFanIn,
  weakDirectDependents,
  zoneBreakdown,
  type CommandChain,
  type GuaranteeRow,
} from './affected.ts';
import { loadGraph } from './load.ts';
import type { GraphNode } from './model.ts';

const USAGE =
  'Usage: pnpm depgraph affected <path> [--json] [--limit <n>]\n' +
  '\n' +
  '  <path>    production file under src/ (repo-relative or absolute)\n' +
  '  --json    unbounded machine-readable output\n' +
  '  --limit   entries per list in text output (default 10)\n';

const HANDLER_CHAIN_FILE = 'src/daemon/request-handler-chain.ts';

/**
 * The live iOS coverage manifest (#1408) is consumed through the narrowest shape this query
 * needs — command name to owning scenario — so this lane does not depend on the rest of that
 * manifest's vocabulary, and reports honestly when it is not in the tree yet.
 */
const LIVE_COVERAGE_MANIFEST = 'test/integration/ios-simulator-e2e/coverage-manifest.ts';
const LIVE_COVERAGE_EXPORT = 'IOS_SIMULATOR_E2E_COVERAGE';

type LiveCoverageEntry = { level: string; owner: unknown; assertion: string };
type LiveOwner = { command: string; level: string; owner: string; assertion: string };

export type BlastRadius = {
  file: string;
  zone: string;
  fanIn: number;
  fanOut: number;
  dependents: {
    direct: string[];
    transitive: string[];
    byZone: { zone: string; count: number }[];
    topByFanIn: { file: string; fanIn: number }[];
    /** Direct importers over the excluded edge kinds — reported, never mixed into the counts. */
    weakDirect: { type: number; dynamic: number };
  };
  gates: { checks: string[]; failOpen: boolean };
  commands: CommandChain[];
  liveOwners: { manifest: string; present: boolean; owners: LiveOwner[] };
  guaranteeRows: GuaranteeRow[];
};

export type Invocation = { file: string; json: boolean; limit: number } | { help: true };

/**
 * `parseArgs` with positionals enabled rather than the shared `parseScriptArgs` helper, which
 * rejects them: partitioning argv by a leading dash would detach `--limit` from its value.
 */
export function parseInvocation(argv: readonly string[]): Invocation {
  const { values, positionals } = parseArgs({
    args: [...argv],
    options: {
      json: { type: 'boolean', default: false },
      limit: { type: 'string', default: '10' },
      help: { type: 'boolean', short: 'h', default: false },
    },
    allowPositionals: true,
  });
  if (values.help) return { help: true };

  const target = positionals[0];
  if (target === undefined) throw new Error(`missing <path>.\n${USAGE}`);
  if (positionals.length > 1) {
    throw new Error(`expected one <path>, got ${positionals.length}: ${positionals.join(' ')}`);
  }
  const limit = Number(values.limit);
  if (!Number.isInteger(limit) || limit < 1) {
    throw new Error(`--limit must be a positive integer, got "${values.limit}"`);
  }
  return { file: target, json: Boolean(values.json), limit };
}

/** Accept an absolute path, a `./`-prefixed one, or the repo-relative form the graph uses. */
function normalizeTarget(target: string, repoRoot: string): string {
  const absolute = path.resolve(repoRoot, target);
  return path.relative(repoRoot, absolute).split(path.sep).join('/');
}

/**
 * Route to handler-entry module, read out of the daemon's own route table rather than
 * duplicated here. A route the table stops declaring becomes a loud failure at the call site,
 * which is the point: a silently empty command list would read as "nothing owns this file".
 */
export function parseRouteEntries(source: string, chainFile: string): Map<string, string> {
  const directory = path.posix.dirname(chainFile);
  const entries = new Map<string, string>();
  const specifierFor = (alias: string): string | undefined =>
    new RegExp(`import \\* as ${alias} from '([^']+)'`).exec(source)?.[1];

  for (const match of source.matchAll(
    /(\w+): defineDaemonRoute\(\{\s*load: (?:\(\) => import\('([^']+)'\)|async \(\) => (\w+))/g,
  )) {
    const specifier = match[2] ?? (match[3] ? specifierFor(match[3]) : undefined);
    if (!specifier) continue;
    entries.set(match[1]!, path.posix.normalize(path.posix.join(directory, specifier)));
  }
  return entries;
}

function commandChains(repoRoot: string): CommandChain[] {
  const source = fs.readFileSync(path.join(repoRoot, HANDLER_CHAIN_FILE), 'utf8');
  const routeEntries = parseRouteEntries(source, HANDLER_CHAIN_FILE);
  const publicCommands = new Set<string>(Object.values(PUBLIC_COMMANDS));
  return DAEMON_COMMAND_DESCRIPTORS.filter((descriptor) =>
    publicCommands.has(descriptor.command),
  ).map((descriptor) => {
    const entry = routeEntries.get(descriptor.route);
    if (!entry) {
      throw new Error(
        `no handler entry for daemon route "${descriptor.route}" — the route table in ` +
          `${HANDLER_CHAIN_FILE} changed shape; update parseRouteEntries in ` +
          `scripts/depgraph/affected-run.ts.`,
      );
    }
    return { command: descriptor.command, route: descriptor.route, entry };
  });
}

/** Flatten the ADR 0011 matrix into one row per (path, guarantee) cell that names a module. */
export function guaranteeRows(): GuaranteeRow[] {
  const rows: GuaranteeRow[] = [];
  for (const [pathId, contract] of Object.entries(INTERACTION_DISPATCH_PATHS) as [
    InteractionPathId,
    (typeof INTERACTION_DISPATCH_PATHS)[InteractionPathId],
  ][]) {
    for (const [guarantee, cell] of Object.entries(contract.guarantees)) {
      if (!('via' in cell)) continue;
      rows.push({ path: pathId, guarantee, kind: cell.kind, via: cell.via });
    }
  }
  return rows;
}

function liveOwnerName(owner: unknown): string {
  if (typeof owner === 'string') return owner;
  if (owner && typeof owner === 'object' && 'path' in owner) {
    const evidence = owner as { path: string; test?: string };
    return evidence.test ? `${evidence.path} — ${evidence.test}` : evidence.path;
  }
  return '(unknown owner)';
}

async function loadLiveOwners(
  repoRoot: string,
  commands: readonly CommandChain[],
): Promise<{ present: boolean; owners: LiveOwner[] }> {
  const manifestPath = path.join(repoRoot, LIVE_COVERAGE_MANIFEST);
  if (!fs.existsSync(manifestPath)) return { present: false, owners: [] };
  const loaded = (await import(pathToFileURL(manifestPath).href)) as Record<string, unknown>;
  const manifest = loaded[LIVE_COVERAGE_EXPORT] as Record<string, LiveCoverageEntry> | undefined;
  if (!manifest) return { present: false, owners: [] };
  return {
    present: true,
    owners: commands.flatMap((chain) => {
      const entry = manifest[chain.command];
      if (!entry) return [];
      return [
        {
          command: chain.command,
          level: entry.level,
          owner: liveOwnerName(entry.owner),
          assertion: entry.assertion,
        },
      ];
    }),
  };
}

export async function computeBlastRadius(repoRoot: string, target: string): Promise<BlastRadius> {
  const graph = loadGraph(repoRoot);
  const nodes = new Map<string, GraphNode>(graph.nodes.map((node) => [node.id, node]));
  const node = nodes.get(target);
  if (!node) {
    throw new Error(
      `${target} is not a production source file in the layering graph ` +
        `(the graph covers git-tracked src/**/*.ts, tests excluded).`,
    );
  }

  const dependents = collectDependents(target, graph.edges);
  const plan: CheckPlan = selectChecks({ changedFiles: [target, ...dependents.all] });
  const commands = commandsReaching(target, commandChains(repoRoot), graph.edges);
  const live = await loadLiveOwners(repoRoot, commands);

  return {
    file: target,
    zone: node.zone,
    fanIn: node.fanIn,
    fanOut: node.fanOut,
    dependents: {
      direct: dependents.direct,
      transitive: dependents.transitiveOnly,
      byZone: zoneBreakdown(dependents.all, nodes),
      topByFanIn: rankByFanIn(dependents.all, nodes),
      weakDirect: weakDirectDependents(target, graph.edges),
    },
    gates: { checks: plan.checks, failOpen: plan.failOpen },
    commands,
    liveOwners: { manifest: LIVE_COVERAGE_MANIFEST, present: live.present, owners: live.owners },
    guaranteeRows: guaranteeRowsForFile(target, guaranteeRows()),
  };
}

/** Bounded text form — the shape an agent reads before spending its context on the edit. */
export function formatBlastRadius(radius: BlastRadius, limit: number): string {
  const { dependents } = radius;
  const lines = [
    `blast radius: ${radius.file}  [zone ${radius.zone}, fan-in ${radius.fanIn}, fan-out ${radius.fanOut}]`,
    `dependents: ${dependents.direct.length} direct, ${dependents.transitive.length} transitive (value edges; ` +
      `${dependents.weakDirect.type} type-only and ${dependents.weakDirect.dynamic} dynamic direct importers not counted)`,
    `  by zone: ${formatBounded(bound(dependents.byZone, limit), (entry) => `${entry.zone} ${entry.count}`)}`,
    `  direct:  ${formatBounded(bound(dependents.direct, limit), (file) => file)}`,
    `  widest:  ${formatBounded(bound(dependents.topByFanIn, limit), (entry) => `${entry.file} (fan-in ${entry.fanIn})`)}`,
    `gates for this set${radius.gates.failOpen ? ' (fail-open: full set)' : ''}: ${radius.gates.checks.join(', ') || '(none)'}`,
    `  run: pnpm check:affected --run`,
    `public commands whose handler chain reaches it (${radius.commands.length}): ` +
      formatBounded(bound(radius.commands, limit), (chain) => `${chain.command} (${chain.route})`),
  ];

  if (!radius.liveOwners.present) {
    lines.push(
      `live scenario owners: ${radius.liveOwners.manifest} is not in this tree (lands with the iOS simulator e2e manifest) — no live claim available`,
    );
  } else {
    lines.push(`live scenario owners (${radius.liveOwners.owners.length}):`);
    for (const owner of bound(radius.liveOwners.owners, limit).shown) {
      lines.push(`  ${owner.command} [${owner.level}] ${owner.owner} — ${owner.assertion}`);
    }
    const hidden = bound(radius.liveOwners.owners, limit).hidden;
    if (hidden > 0) lines.push(`  (+${hidden} more)`);
  }

  lines.push(`guarantee-matrix rows implemented here (${radius.guaranteeRows.length}):`);
  for (const row of bound(radius.guaranteeRows, limit).shown) {
    lines.push(`  ${row.path}/${row.guarantee} [${row.kind}] ${row.via}`);
  }
  const hiddenRows = bound(radius.guaranteeRows, limit).hidden;
  if (hiddenRows > 0) lines.push(`  (+${hiddenRows} more)`);

  return `${lines.join('\n')}\n`;
}

export async function runAffected(argv: readonly string[], repoRoot: string): Promise<number> {
  const invocation = parseInvocation(argv);
  if ('help' in invocation) {
    process.stdout.write(USAGE);
    return 0;
  }
  const { file, json, limit } = invocation;
  const radius = await computeBlastRadius(repoRoot, normalizeTarget(file, repoRoot));
  process.stdout.write(
    json ? `${JSON.stringify(radius, null, 2)}\n` : formatBlastRadius(radius, limit),
  );
  return 0;
}
