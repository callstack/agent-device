// Decision spike for #3278: measures fallow `boundaries` and dependency-cruiser against the custom
// layering model for R2, R4, R5, R6, R77, R78, R14 and R71. Not a gate and not wired into any
// check; ADR 0032's tables are this script's output, and the ADR says when to delete it.
//
// Usage (engines are not repository dependencies; install them into a scratch directory):
//   pnpm add --dir <dir> fallow@3.32.0 dependency-cruiser@18.5.0 typescript@6.0.3 @swc/core \
//     --config.node-linker=hoisted
//   node --experimental-strip-types scripts/layering/boundary-engine-spike.ts <dir>
//
// dependency-cruiser 18.5 accepts `typescript >=2 <7`; the repository's TypeScript 7 cannot parse
// for it, hence TypeScript 6, with swc measured as the alternative parser.
//
// The engines read the disk while the custom rules read tracked files, so the script refuses to run
// unless the production roots hold exactly the tracked tree. Plants are recorded in a manifest
// before any file changes. Normal exit, a thrown error and SIGINT/SIGTERM/SIGHUP all restore the tree
// from it; after a SIGKILL, the next run restores it first, or stops untouched if a planted file was
// edited in between.

import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { LAYERING_RULES, type LayeringContext, type LayeringRuleId } from './check.ts';
import { RANKED_ZONES, resolveImportEdges, targetDagZone, zoneRank } from './model.ts';
import { workspaceSpecifierTargets } from './package-boundaries.ts';
import { measureRatchets } from './ratchet-reference.ts';
import { RUNNER_SUBTREE } from './apple-runner-host-port-policy.ts';
import {
  isProductionSourceFile,
  listTrackedProductionSources,
  listTrackedTypeScriptFiles,
} from './tracked-sources.ts';

const repoRoot = execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim();
const enginesDir = path.resolve(process.argv[2] ?? '');
const FALLOW = path.join(enginesDir, 'node_modules/.bin/fallow');
const DEPCRUISE = path.join(enginesDir, 'node_modules/.bin/depcruise');
const RUNS = 5;
const PRODUCTION_ROOTS = ['src', 'packages/*/src'];
const OUT = path.join(repoRoot, '.tmp/boundary-engine-spike');
const PLANT_MANIFEST = path.join(repoRoot, '.tmp/boundary-engine-spike.plants.json');

type Kind = 'value' | 'type' | 'dynamic';
type Pair = `${string} -> ${string}`;

// Zones: the inverse of `targetDagZone`, as a path regex (dependency-cruiser) and a glob (fallow).
function zoneRoot(zone: string, files: readonly string[]): { regex: string; glob: string } {
  if (zone === '(root)') return { regex: '^src/[^/]+\\.ts$', glob: 'src/*.ts' };
  const sample = files.find((file) => targetDagZone(file) === zone)!;
  const root = sample.startsWith('packages/')
    ? `packages/${zone}/src/`
    : zone === 'daemon-server'
      ? 'src/daemon/'
      : `src/${zone}/`;
  return { regex: `^${root.replaceAll('.', String.raw`\.`)}`, glob: `${root}**` };
}

function higherRanked(zone: string): string[] {
  const rank = zoneRank(zone);
  if (rank === null) return [];
  return [...RANKED_ZONES].filter((other) => zoneRank(other)! > rank).sort();
}

const R2_HINT = 'commands/ sits above core/ and daemon/; put the shared rule below both.';
const R5_HINT = 'value import against the ranked spine; move the contract below both zones.';
const R6_HINT = 'type-only import against the ranked spine; move the type below both zones.';
const R77_HINT = 'reach host-kit through the runner host port (runner/host.ts).';
const R78_HINT = 'the client reaches the daemon over the network; read only recorded types.';
const RETIRED_HINT = 'retired root; move the file to its owning package or command zone.';

// dependency-cruiser configuration, generated from the same declarations the custom rules read.

const TYPE_DEPS = ['type-only', 'type-import'];
/** Test modules, helpers included. Only R77 polices them; every other rule is production-only. */
const TEST_PATH = String.raw`(^|/)__tests__/|\.test\.ts$`;

const rule = (name: string, comment: string, from: object, to: object) => ({
  name,
  comment,
  severity: 'error',
  from,
  to,
});

function depcruiseConfig(zones: readonly string[], files: readonly string[]) {
  const rx = (zone: string) => zoneRoot(zone, files).regex;
  const runtime = [...TYPE_DEPS, 'dynamic-import'];
  const forbidden = [
    rule('R2-commands-floor', R2_HINT, { path: '^src/(core|daemon)/' }, { path: '^src/commands/' }),
    rule(
      'R2-commands-schema',
      'commands/schema/ renders the command facets; commands must not import it back.',
      { path: '^src/commands/', pathNot: '^src/commands/schema/' },
      { path: '^src/commands/schema/' },
    ),
    rule(
      'R4-value-import-cycle',
      'production value-import cycle; type-only and dynamic edges do not count.',
      { pathNot: TEST_PATH },
      {
        circular: true,
        pathNot: TEST_PATH,
        dependencyTypesNot: runtime,
        viaOnly: { pathNot: TEST_PATH, dependencyTypesNot: runtime },
      },
    ),
    rule(
      'R77-apple-runner-host-port',
      R77_HINT,
      { path: `^${RUNNER_SUBTREE}` },
      { path: '^packages/host-kit/src/', dependencyTypesNot: TYPE_DEPS },
    ),
    rule(
      'R78-daemon-client-runtime',
      R78_HINT,
      { path: '^src/daemon-client/' },
      { path: '^src/daemon/', dependencyTypesNot: TYPE_DEPS },
    ),
    // The recorded type edges live in the known-violations baseline.
    rule(
      'R78-daemon-client-type',
      R78_HINT,
      { path: '^src/daemon-client/' },
      { path: '^src/daemon/', dependencyTypes: TYPE_DEPS },
    ),
    // A retired root is reached by an outgoing, incoming, or no edge at all.
    ...[
      ['R14', '^src/utils/'],
      ['R71', '^src/replay/'],
    ].flatMap(([id, root]) => [
      rule(`${id}-retired-out`, RETIRED_HINT, { path: root }, {}),
      rule(`${id}-retired-in`, RETIRED_HINT, {}, { path: root }),
      rule(`${id}-retired-orphan`, RETIRED_HINT, { path: root, orphan: true }, {}),
    ]),
  ];
  for (const zone of zones) {
    const higher = higherRanked(zone);
    if (higher.length === 0) continue;
    const from = { path: rx(zone), pathNot: TEST_PATH };
    const to = `(${higher.map(rx).join('|')})`;
    forbidden.push(
      rule(`R5-zero-back-edges.${zone}`, R5_HINT, from, { path: to, dependencyTypesNot: runtime }),
      // Ratcheted through the known-violations baseline.
      rule(`R6-type-spine-inversion.${zone}`, R6_HINT, from, {
        path: to,
        dependencyTypes: TYPE_DEPS,
      }),
    );
  }
  return {
    forbidden,
    options: {
      tsPreCompilationDeps: true,
      tsConfig: { fileName: 'tsconfig.json' },
      includeOnly: '^(src|packages/[^/]+/src)/',
      // R77 polices runner test files too, so only they stay in the graph.
      exclude: { path: `^(?!${RUNNER_SUBTREE}).*(${TEST_PATH})` },
      doNotFollow: { path: 'node_modules' },
      enhancedResolveOptions: {
        exportsFields: ['exports'],
        conditionNames: ['types', 'import', 'default'],
        extensions: ['.ts', '.js'],
      },
      cache: false,
    },
  };
}

// fallow configuration. Zones are first-match; rules are per-zone allowlists, so the generator
// turns each forbidden set into its complement.

function fallowConfig(
  zones: readonly string[],
  files: readonly string[],
  rulePack: string,
  unmatched: readonly string[],
) {
  // First match wins: runner tests stay under R77, every other test file is unrestricted.
  const special = [
    { name: 'apple-runner', patterns: [`${RUNNER_SUBTREE}**`] },
    { name: 'tests', patterns: ['**/__tests__/**', '**/*.test.ts'] },
    { name: 'commands-schema', patterns: ['src/commands/schema/**'] },
  ];
  // fallow's `*` crosses `/`, so the root zone names its files.
  const base = zones.map((zone) => ({
    name: zone,
    patterns:
      zone === '(root)'
        ? files.filter((file) => targetDagZone(file) === zone)
        : [zoneRoot(zone, files).glob],
  }));
  const all = [...special, ...base].map((zone) => zone.name);
  const parent: Record<string, string> = {
    'apple-runner': 'platform-apple',
    tests: '(tests)',
    'commands-schema': 'commands',
  };
  const effectiveZone = (name: string) => parent[name] ?? name;
  const forbiddenFor = (name: string): Set<string> => {
    const zone = effectiveZone(name);
    const forbidden = new Set(higherRanked(zone));
    if (zone === 'core' || zone === 'daemon-server') forbidden.add('commands');
    if (zone === 'daemon-client') forbidden.add('daemon-server');
    if (name === 'commands') forbidden.add('commands-schema');
    // A forbidden effective zone forbids every special zone that maps onto it.
    for (const other of all) if (forbidden.has(effectiveZone(other))) forbidden.add(other);
    if (name === 'commands-schema') forbidden.delete('commands');
    return forbidden;
  };
  return {
    rulePacks: [rulePack],
    circularDependencies: { ignoreLazyImports: true },
    boundaries: {
      zones: [...special, ...base],
      rules: all.map((name) => {
        const forbidden = forbiddenFor(name);
        return { from: name, allow: all.filter((zone) => zone !== name && !forbidden.has(zone)) };
      }),
      // R14/R71: a file under a retired root matches no zone. Everything outside the production
      // roots may stay unmatched.
      coverage: { requireAllFiles: true, allowUnmatched: unmatched },
    },
  };
}

const R77_RULE_PACK = {
  version: 1,
  name: 'layering',
  rules: [
    {
      id: 'R77-apple-runner-host-port',
      kind: 'banned-import',
      specifiers: ['@agent-device/host-kit/*'],
      ignoreTypeOnly: true,
      zones: ['apple-runner'],
      message: R77_HINT,
      severity: 'error',
    },
  ],
};

/** Globs for every tracked path outside the production roots, plus test files inside them. */
function nonProductionGlobs(): string[] {
  const tracked = execFileSync('git', ['ls-files', '-z'], { cwd: repoRoot, encoding: 'utf8' })
    .split('\0')
    .filter(Boolean);
  const globs = new Set(['**/__tests__/**', '**/*.test.ts']);
  for (const file of tracked) {
    const parts = file.split('/');
    const [top, pkg, sub] = parts;
    if (top === 'src') continue;
    if (top !== 'packages') globs.add(parts.length === 1 ? top! : `${top}/**`);
    else if (sub !== 'src') globs.add(parts.length === 3 ? file : `packages/${pkg}/${sub}/**`);
  }
  return [...globs].sort();
}

type Finding = { rule: string; from: string; to: string; message: string };

const SPAWN = { cwd: repoRoot, encoding: 'utf8', maxBuffer: 1 << 30 } as const;
const DEPCRUISE_ROOTS = ['src', 'packages'];
const FALLOW_ARGS = ['dead-code', '--no-cache', '--quiet', '--format', 'json'];
const FALLOW_FILTERS = ['--boundary-violations', '--circular-deps', '--policy-violations'];

function run(bin: string, args: readonly string[]) {
  const { stdout, stderr, status, signal } = spawnSync(bin, args, SPAWN);
  // A signal reaches the child too; stop here so the plants are restored rather than measured.
  if (signal) throw new Error(`${path.basename(bin)} stopped by ${signal}`);
  return { stdout, stderr, status };
}

function parseOutput<T>(label: string, result: ReturnType<typeof run>): T {
  try {
    return JSON.parse(result.stdout) as T;
  } catch {
    throw new Error(
      `${label} exited ${result.status} without JSON output:\n${result.stderr.trim().slice(-2000)}`,
    );
  }
}

/** Median wall time of `RUNS` calls after one warm-up, and the last result. */
function timed<T>(measure: () => T): { last: T; ms: number } {
  const times: number[] = [];
  let last = measure();
  for (let index = 0; index < RUNS; index++) {
    const start = performance.now();
    last = measure();
    times.push(performance.now() - start);
  }
  return { last, ms: times.sort((a, b) => a - b)[Math.floor(RUNS / 2)]! };
}

function finding(rule: string, from: string, to = '', message = ''): Finding {
  return { rule, from, to, message };
}

function depcruise(config: string, extra: readonly string[] = []) {
  const output = run(DEPCRUISE, ['--config', config, '-T', 'json', ...extra, ...DEPCRUISE_ROOTS]);
  const result = parseOutput<{
    modules: { source: string; dependencies: { resolved: string; dependencyTypes: string[] }[] }[];
    summary: {
      baselineStale?: number;
      violations: {
        rule: { name: string };
        from: string;
        to: string;
        cycle?: { name: string }[];
      }[];
    };
  }>('dependency-cruiser', output);
  const findings = result.summary.violations.map((v) =>
    finding(v.rule.name, v.from, v.to, v.cycle?.map((step) => step.name).join(' -> ')),
  );
  return { result, findings, status: output.status };
}

/** `filtered: false` runs every issue type, which the stale-baseline gate requires. */
function fallow(config: string, extra: readonly string[] = [], filtered = true) {
  const filters = filtered ? FALLOW_FILTERS : [];
  const output = run(FALLOW, [...FALLOW_ARGS, '--config', config, ...filters, ...extra]);
  const json = parseOutput<{
    boundary_violations: { from_path: string; to_path: string }[];
    boundary_coverage_violations: { path: string }[];
    circular_dependencies: { files: string[] }[];
    policy_violations: { path: string; rule_id?: string; message?: string }[];
    gate_outcomes?: Record<string, { status?: string; failed?: boolean }>;
  }>('fallow', output);
  const findings = [
    ...json.boundary_violations.map((v) => finding('boundary-violation', v.from_path, v.to_path)),
    ...json.boundary_coverage_violations.map((v) => finding('boundary-coverage', v.path)),
    ...json.circular_dependencies.map((v) =>
      finding('circular-dependency', v.files[0]!, v.files.at(-1)!, v.files.join(' -> ')),
    ),
    ...json.policy_violations.map((v) => finding(`policy:${v.rule_id ?? ''}`, v.path)),
  ];
  return { json, findings };
}

// Custom side: the real rule registry over in-memory sources.

const RULE_IDS: readonly LayeringRuleId[] = [
  'zone-policies',
  'commands-schema-boundary',
  'value-import-cycles',
  'back-edges',
  'type-spine-inversions',
  'apple-runner-host-port',
  'daemon-client-entry',
  'src-utils-retirement',
  'replay-ownership',
];

function readSources(files: readonly string[]): Map<string, string> {
  return new Map(files.map((file) => [file, fs.readFileSync(path.join(repoRoot, file), 'utf8')]));
}

function customContext(
  sources: Map<string, string>,
  allSources: Map<string, string>,
  trackedSrcUtilsFiles: readonly string[],
  reference: LayeringContext['reference'],
): LayeringContext {
  const edges = resolveImportEdges(sources, workspaceSpecifierTargets(repoRoot));
  return {
    sourceFiles: [...sources.keys()],
    sources,
    allTypeScriptSources: allSources,
    trackedSrcUtilsFiles,
    edges,
    ratchets: measureRatchets(sources, edges),
    reference,
  };
}

const customRules = (context: LayeringContext) =>
  RULE_IDS.flatMap((id) => LAYERING_RULES[id](context));

// Planted violations. `flag` plants must be reported under their rule; `pass` plants are the
// closest negatives the custom rule deliberately admits.

type Plant = {
  id: string;
  rule: string;
  expect: 'flag' | 'pass';
  files?: Record<string, string>;
  edit?: { file: string; from: string; to: string };
  /** Detected by an engine only as a stale known-violation; measured on an otherwise clean tree. */
  stale?: true;
};

const RUNNER = RUNNER_SUBTREE;
const HOST_KIT = "'@agent-device/host-kit/command'";
const CLI = "'../cli/auth-session.ts'";
const COMMANDS = "'../commands/batch/metadata.ts'";
const prepend = (file: string, to: string) => ({ file, from: '', to });

function plant(rule: string, expect: Plant['expect'], id: string, change: Partial<Plant>): Plant {
  return { rule, expect, id: `${rule} ${id}`, ...change };
}

const PLANTS: readonly Plant[] = [
  plant('R2', 'flag', 'daemon value-imports commands', {
    files: { 'src/daemon/ws2-plant-r2.ts': `export { x } from ${COMMANDS};` },
  }),
  plant('R2', 'flag', 'core type-imports commands', {
    files: { 'src/core/ws2-plant-r2-type.ts': `export type { BatchInput } from ${COMMANDS};` },
  }),
  plant('R2', 'flag', 'commands imports commands/schema', {
    files: { 'src/commands/ws2-plant-r2-schema.ts': "export { y } from './schema/cli-config.ts';" },
  }),
  plant('R4', 'flag', 'value cycle', {
    files: {
      'src/core/ws2-plant-r4-a.ts': "export { b } from './ws2-plant-r4-b.ts';",
      'src/core/ws2-plant-r4-b.ts': "export { a } from './ws2-plant-r4-a.ts';",
    },
  }),
  plant('R4', 'pass', 'type-only cycle', {
    files: {
      'src/core/ws2-plant-r4t-a.ts': "export type { B } from './ws2-plant-r4t-b.ts';",
      'src/core/ws2-plant-r4t-b.ts': "export type { A } from './ws2-plant-r4t-a.ts';",
    },
  }),
  plant('R4', 'pass', 'cycle closed by a lazy import()', {
    files: {
      'src/core/ws2-plant-r4d-a.ts': "export { b } from './ws2-plant-r4d-b.ts';",
      'src/core/ws2-plant-r4d-b.ts': "export const b = () => import('./ws2-plant-r4d-a.ts');",
    },
  }),
  plant('R5', 'flag', 'core value-imports cli', {
    files: { 'src/core/ws2-plant-r5.ts': `export { x } from ${CLI};` },
  }),
  plant('R5', 'flag', 'static re-export after an import() type', {
    files: {
      'src/core/ws2-plant-r5-mask.ts': `export type T = import(${CLI}).X;\nexport { x } from ${CLI};`,
    },
  }),
  plant('R5', 'pass', 'core lazy-imports cli', {
    files: { 'src/core/ws2-plant-r5-dynamic.ts': `export const load = () => import(${CLI});` },
  }),
  plant('R6', 'flag', 'new type-only inversion pair', {
    files: { 'src/core/ws2-plant-r6.ts': `export type { CliSessionRecord } from ${CLI};` },
  }),
  // fallow evaluates rule packs only in files an entry point reaches, so the R77 forms are planted
  // into reachable runner modules; the orphan plant isolates that reachability condition.
  plant('R77', 'flag', 'named import, reachable runner module', {
    edit: prepend(
      `${RUNNER}runner-provider.ts`,
      `import { runCmd as ws2 } from ${HOST_KIT};ws2;\n`,
    ),
  }),
  plant('R77', 'flag', 're-export, reachable runner module', {
    edit: prepend(`${RUNNER}runner-artifact.ts`, `export { runCmd as ws2 } from ${HOST_KIT};\n`),
  }),
  plant('R77', 'flag', 'lazy import(), reachable runner module', {
    edit: prepend(`${RUNNER}runner-cache.ts`, `export const ws2 = () => import(${HOST_KIT});\n`),
  }),
  plant('R77', 'flag', 'named import, orphan runner module', {
    files: { [`${RUNNER}ws2-plant-r77.ts`]: `import { runCmd } from ${HOST_KIT};runCmd;` },
  }),
  plant('R77', 'flag', 'runner test file value-imports host-kit', {
    files: { [`${RUNNER}ws2-plant-r77.test.ts`]: `import ${HOST_KIT};` },
  }),
  plant('R77', 'flag', 'lazy import after an import() type', {
    files: {
      [`${RUNNER}ws2-plant-r77-mask.ts`]: `export type E = import(${HOST_KIT}).ExecResult;\nexport const l = () => import(${HOST_KIT});`,
    },
  }),
  plant('R77', 'pass', 'runner type-imports host-kit', {
    files: { [`${RUNNER}ws2-plant-r77-type.ts`]: `export type { ExecResult } from ${HOST_KIT};` },
  }),
  plant('R78', 'flag', 'client value-imports daemon', {
    files: { 'src/daemon-client/ws2-plant-r78.ts': "export { x } from '../daemon/app-events.ts';" },
  }),
  plant('R78', 'flag', 'unrecorded client type import', {
    files: {
      'src/daemon-client/ws2-plant-r78-type.ts':
        "export type { DaemonRequest } from '../daemon/daemon-request.ts';",
    },
  }),
  plant('R78', 'flag', 'recorded edge removed (stale)', {
    stale: true,
    edit: {
      file: 'src/daemon-client/daemon-client-lease-beat.ts',
      from: "import type { DaemonRequest } from '../daemon/daemon-request.ts';",
      to: 'type DaemonRequest = never;',
    },
  }),
  plant('R14', 'flag', 'orphan .ts under src/utils', {
    files: { 'src/utils/ws2-plant.ts': 'export const u = 1;' },
  }),
  plant('R14', 'flag', 'non-TS file under src/utils', {
    files: { 'src/utils/ws2-plant.md': '# planted' },
  }),
  plant('R71', 'flag', 'file under src/replay', {
    files: { 'src/replay/ws2-plant.ts': `export { x } from '../commands/batch/metadata.ts';` },
  }),
];

const plantFiles = (plant: Plant) => [
  ...Object.keys(plant.files ?? {}),
  ...(plant.edit ? [plant.edit.file] : []),
];

/** Every file a plant touches: its content before the plant (`null`: absent) and as planted. */
type PlantManifest = Record<string, { before: string | null; planted: string }>;

function readOrNull(file: string): string | null {
  const full = path.join(repoRoot, file);
  return fs.existsSync(full) ? fs.readFileSync(full, 'utf8') : null;
}

/**
 * Undoes the recorded plants, whichever run wrote them; a no-op when none are on disk. A file holding
 * neither its planted nor its original content was edited since, so nothing is restored at all.
 */
function restorePlants(): void {
  if (!fs.existsSync(PLANT_MANIFEST)) return;
  const manifest = JSON.parse(fs.readFileSync(PLANT_MANIFEST, 'utf8')) as PlantManifest;
  const files = Object.entries(manifest).map(([file, entry]) => ({
    file,
    ...entry,
    now: readOrNull(file),
  }));
  const changed = files.filter(({ before, planted, now }) => now !== planted && now !== before);
  if (changed.length > 0) {
    throw new Error(
      'edited since they were planted, so nothing was restored. Return each to its planted or ' +
        `original content, then re-run to restore the rest (${PLANT_MANIFEST}):\n` +
        changed.map(({ file }) => file).join('\n'),
    );
  }
  for (const { file, before, planted, now } of files) {
    if (now !== planted) continue;
    if (before === null) fs.rmSync(path.join(repoRoot, file));
    else fs.writeFileSync(path.join(repoRoot, file), before);
  }
  for (const dir of ['src/utils', 'src/replay']) {
    const full = path.join(repoRoot, dir);
    if (fs.existsSync(full) && fs.readdirSync(full).length === 0) fs.rmdirSync(full);
  }
  fs.rmSync(PLANT_MANIFEST);
}

/** Records every planned change in the manifest before touching the tree. */
function writePlants(plants: readonly Plant[] = PLANTS): void {
  const manifest: PlantManifest = {};
  for (const plant of plants) {
    for (const [file, content] of Object.entries(plant.files ?? {})) {
      manifest[file] = { before: readOrNull(file), planted: `${content}\n` };
    }
    if (!plant.edit) continue;
    const { file, from, to } = plant.edit;
    const before = readOrNull(file);
    if (!before?.includes(from)) throw new Error(`edit anchor missing in ${file}`);
    manifest[file] = { before, planted: before.replace(from, to) };
  }
  fs.mkdirSync(path.dirname(PLANT_MANIFEST), { recursive: true });
  fs.writeFileSync(PLANT_MANIFEST, JSON.stringify(manifest));
  for (const [file, { planted }] of Object.entries(manifest)) {
    fs.mkdirSync(path.dirname(path.join(repoRoot, file)), { recursive: true });
    fs.writeFileSync(path.join(repoRoot, file), planted);
  }
}

/** The engines read the disk and the custom rules read tracked files: their inputs must agree. */
function assertTrackedScope(): void {
  const drift = execFileSync(
    'git',
    ['status', '--porcelain', '--ignored', '--untracked-files=all', '--', ...PRODUCTION_ROOTS],
    { cwd: repoRoot, encoding: 'utf8' },
  ).trim();
  if (drift) {
    throw new Error(`production roots differ from the tracked tree; clean them first:\n${drift}`);
  }
}

/** The repository's fallow config as 3.x reads it: no `//` lines, no `comment` annotations. */
function repoFallowConfig(): Record<string, unknown> {
  const text = fs.readFileSync(path.join(repoRoot, '.fallowrc.json'), 'utf8');
  return JSON.parse(text.replaceAll(/^\s*\/\/.*$/gm, ''), (key, value: unknown) =>
    key === 'comment' ? undefined : value,
  ) as Record<string, unknown>;
}

function hits(plant: Plant, findings: readonly Finding[], rulePrefix: RegExp | null): Finding[] {
  const files = plantFiles(plant);
  return findings.filter(
    (finding) =>
      (rulePrefix === null || rulePrefix.test(finding.rule)) &&
      files.some(
        (file) => finding.from === file || finding.to === file || finding.message.includes(file),
      ),
  );
}

function pairKinds(edges: readonly { file: string; target: string; kind: Kind }[]) {
  const pairs = new Map<Pair, Set<Kind>>();
  for (const edge of edges) {
    const key: Pair = `${edge.file} -> ${edge.target}`;
    const kinds = pairs.get(key) ?? new Set<Kind>();
    kinds.add(edge.kind);
    pairs.set(key, kinds);
  }
  return pairs;
}

const kindTag = (kinds: Set<Kind> | undefined) => (kinds ? [...kinds].sort().join('+') : 'absent');

function tally<T extends string>(keys: Iterable<T>): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const key of keys) counts[key] = (counts[key] ?? 0) + 1;
  return Object.fromEntries(Object.entries(counts).sort(([a], [b]) => a.localeCompare(b)));
}

function main(): void {
  const engines = [FALLOW, DEPCRUISE, path.join(enginesDir, 'node_modules/@swc/core')];
  if (!engines.every((engine) => fs.existsSync(engine))) {
    throw new Error('usage: boundary-engine-spike.ts <dir with the engines in the header>');
  }
  for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP'] as const) {
    process.on(signal, () => {
      restorePlants();
      process.exit(128 + os.constants.signals[signal]);
    });
  }
  restorePlants();
  assertTrackedScope();
  // fallow refuses rule packs outside the project root; `.tmp/` is gitignored.
  fs.rmSync(OUT, { recursive: true, force: true });
  fs.mkdirSync(OUT, { recursive: true });
  const files = listTrackedProductionSources(repoRoot);
  const fileSet = new Set(files);
  const zones = [...new Set(files.map(targetDagZone))].sort();
  const sources = readSources(files);
  const allSources = readSources(listTrackedTypeScriptFiles(repoRoot));

  // Custom baseline and runtime.
  const reference = {
    ref: 'HEAD',
    ...measureRatchets(sources, resolveImportEdges(sources, workspaceSpecifierTargets(repoRoot))),
  };
  const customGraph = timed(() => resolveImportEdges(sources, workspaceSpecifierTargets(repoRoot)));
  const cleanContext = customContext(sources, allSources, [], reference);
  const customTimed = timed(() => customRules(cleanContext));
  const custom = pairKinds(
    cleanContext.edges.map((edge) => ({
      file: edge.file,
      target: edge.target,
      kind: edge.dynamic ? 'dynamic' : edge.typeOnly ? 'type' : 'value',
    })),
  );

  // Configs.
  const writeConfig = (name: string, config: object) => {
    const file = path.join(OUT, name);
    fs.writeFileSync(file, JSON.stringify(config, null, 1));
    return file;
  };
  const dcRules = depcruiseConfig(zones, files);
  const dcConfig = writeConfig('depcruise.json', dcRules);
  const dcSwcConfig = writeConfig('depcruise-swc.json', {
    ...dcRules,
    options: { ...dcRules.options, parser: 'swc' },
  });
  const rulePack = writeConfig('layering.rulepack.json', R77_RULE_PACK);
  const boundaries = fallowConfig(zones, files, rulePack, nonProductionGlobs());
  const fallowRc = writeConfig('fallow.json', boundaries);

  // Edge sets. dependency-cruiser exposes the graph with kinds; fallow exposes kinds only through
  // boundary findings, so one zone per file is the instrument: `allow: []` reports every edge,
  // and `allowTypeOnly: [every zone]` reports the edges fallow considers runtime.
  const dcTimed = timed(() => depcruise(dcConfig));
  const dc = dcTimed.last;
  const dcPairs = pairKinds(
    dc.result.modules.flatMap((module) =>
      module.dependencies
        .filter((dep) => fileSet.has(module.source) && fileSet.has(dep.resolved))
        .map((dep) => ({
          file: module.source,
          target: dep.resolved,
          kind: (dep.dependencyTypes.includes('dynamic-import')
            ? 'dynamic'
            : dep.dependencyTypes.some((type) => TYPE_DEPS.includes(type))
              ? 'type'
              : 'value') as Kind,
        })),
    ),
  );

  const perFile = (typeOnly: boolean) => {
    const names = files.map((_, index) => `f${index}`);
    const config = {
      boundaries: {
        zones: files.map((file, index) => ({ name: names[index], patterns: [file] })),
        rules: names.map((name) =>
          typeOnly ? { from: name, allow: [], allowTypeOnly: names } : { from: name, allow: [] },
        ),
      },
    };
    const file = path.join(OUT, `fallow-per-file-${typeOnly}.json`);
    fs.writeFileSync(file, JSON.stringify(config));
    const { json } = fallow(file);
    return new Set(
      json.boundary_violations
        .filter((v) => fileSet.has(v.from_path) && fileSet.has(v.to_path))
        .map((v): Pair => `${v.from_path} -> ${v.to_path}`),
    );
  };
  const fallowAll = perFile(false);
  const fallowRuntime = perFile(true);
  const fallowPairs = new Map<Pair, Set<Kind>>(
    [...fallowAll].map((pair) => [
      pair,
      new Set<Kind>([fallowRuntime.has(pair) ? 'value' : 'type']),
    ]),
  );

  const fallowTimed = timed(() => fallow(fallowRc));
  const fallowClean = fallowTimed.last;

  // What boundaries would cost inside the repository's own dead-code run.
  const repoRc = writeConfig('fallow-repo.json', repoFallowConfig());
  const repoBoundariesRc = writeConfig('fallow-repo-boundaries.json', {
    ...repoFallowConfig(),
    ...boundaries,
  });
  const runtimeMs = {
    customGraph: customGraph.ms,
    customRules: customTimed.ms,
    depcruiseTsc: dcTimed.ms,
    depcruiseSwc: timed(() => depcruise(dcSwcConfig)).ms,
    fallowBoundaries: fallowTimed.ms,
    fallowRepoDeadCode: timed(() => fallow(repoRc, [], false)).ms,
    fallowRepoDeadCodeWithBoundaries: timed(() => fallow(repoBoundariesRc, [], false)).ms,
  };

  // Clean-tree baselines: the R6 survivors and R78's recorded type edges are the only findings the
  // custom rules admit, so the engines carry them as known violations.
  const dcBaseline = path.join(OUT, 'depcruise-known.json');
  fs.writeFileSync(
    dcBaseline,
    run(DEPCRUISE, ['--config', dcConfig, '-T', 'baseline', ...DEPCRUISE_ROOTS]).stdout,
  );
  const fallowBaseline = path.join(OUT, 'fallow-baseline.json');
  fallow(fallowRc, ['--save-baseline', fallowBaseline], false);

  // The stale-baseline gate judges only unfiltered runs. Control: the unplanted tree passes it.
  const fallowStaleGate = () =>
    fallow(fallowRc, ['--baseline', fallowBaseline, '--fail-on-stale-baseline'], false).json
      .gate_outcomes?.['stale-baseline'];
  const fallowStaleControl = fallowStaleGate();

  // Planted run.
  writePlants();
  let planted: { custom: Finding[]; dc: Finding[]; fallow: Finding[] };
  try {
    // The custom side reads the planted tree as if it were tracked.
    const touched = [...new Set(PLANTS.flatMap(plantFiles))];
    const plantedTs = touched.filter((file) => file.endsWith('.ts'));
    const customPlanted = customRules(
      customContext(
        readSources([...new Set([...files, ...plantedTs.filter(isProductionSourceFile)])]),
        readSources([...new Set([...allSources.keys(), ...plantedTs])]),
        touched.filter((file) => file.startsWith('src/utils/')),
        reference,
      ),
    );
    const fallowPlanted = fallow(fallowRc, ['--baseline', fallowBaseline]);
    planted = {
      custom: customPlanted.map((v) => finding(v.rule, v.file, '', v.message)),
      dc: depcruise(dcConfig, ['--ignore-known', dcBaseline]).findings,
      fallow: fallowPlanted.findings,
    };
  } finally {
    restorePlants();
  }

  // Stale known violations, one plant at a time so no other change can stale an entry.
  const staleVerdicts = new Map<string, { depcruise: string[]; fallow: string[] }>();
  for (const plant of PLANTS.filter((candidate) => candidate.stale)) {
    writePlants([plant]);
    try {
      const gate = fallowStaleGate();
      const dcRun = depcruise(dcConfig, ['--ignore-known', dcBaseline]);
      const { baselineStale } = dcRun.result.summary;
      staleVerdicts.set(plant.id, {
        depcruise: baselineStale
          ? [`summary.baselineStale=${baselineStale} (exit ${dcRun.status})`]
          : [],
        fallow: gate?.status === 'fail' ? ['stale-baseline gate (exit 1)'] : [],
      });
    } finally {
      restorePlants();
    }
  }

  const diff = (engine: Map<Pair, Set<Kind>>, collapseDynamic: boolean) => {
    // Collapsed, a pair is `value` if any edge evaluates at runtime, else `type`.
    const norm = (kinds: Set<Kind> | undefined) =>
      kinds && collapseDynamic
        ? new Set<Kind>([kinds.has('value') || kinds.has('dynamic') ? 'value' : 'type'])
        : kinds;
    const keys = new Set([...custom.keys(), ...engine.keys()]);
    return {
      customPairs: custom.size,
      enginePairs: engine.size,
      customOnly: [...keys].filter((key) => !engine.has(key)).length,
      engineOnly: [...keys].filter((key) => !custom.has(key)).sort(),
      kindMismatches: tally(
        [...keys]
          .filter((key) => custom.has(key) && engine.has(key))
          .map((key) => [kindTag(norm(custom.get(key))), kindTag(norm(engine.get(key)))] as const)
          .filter(([left, right]) => left !== right)
          .map(([left, right]) => `${left} => ${right}`),
      ),
    };
  };

  const parity = PLANTS.map((plant) => {
    const rx = new RegExp(`^${plant.rule}\\b`);
    const custom = hits(plant, planted.custom, rx);
    const dc = hits(plant, planted.dc, rx);
    const fb = hits(plant, planted.fallow, null);
    return {
      plant: plant.id,
      expect: plant.expect,
      custom: custom.map((f) => f.rule),
      depcruise: [...dc.map((f) => f.rule), ...(staleVerdicts.get(plant.id)?.depcruise ?? [])],
      fallow: [
        ...(plant.stale ? [] : fb.map((f) => f.rule)),
        ...(staleVerdicts.get(plant.id)?.fallow ?? []),
      ],
    };
  });

  const report = {
    tree: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repoRoot, encoding: 'utf8' }).trim(),
    files: files.length,
    zones: zones.length,
    runtimeMs,
    edgeDiff: {
      depcruise: diff(dcPairs, false),
      // fallow does not separate dynamic from static imports: compare on value|type.
      fallow: diff(fallowPairs, true),
    },
    cleanTreeFindings: {
      custom: customTimed.last.length,
      depcruise: tally(dc.findings.map((f) => f.rule.replace(/\..*$/, ''))),
      fallow: tally(fallowClean.findings.map((f) => f.rule)),
    },
    parity,
    fallowStaleBaselineUnplanted: fallowStaleControl,
    artifacts: OUT,
  };
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
}

main();
