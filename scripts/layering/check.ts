// Import-direction lint — enforces the folder DAG established by the Phase-5
// folder moves (see CONTEXT.md, "Architecture: folder DAG + layering lint").
//
// Target DAG (imports point DOWN, toward the kernel sink):
//   kernel ◄ platforms ◄ core ◄ commands ◄ { cli, client, daemon/server }
//   client ◄ daemon/client     remote, metro ◄ daemon/client
//   sdk = re-export barrels only
//
// The full zero-back-edge DAG remains a target. This gate enforces the three
// completed-move rules, rejects all production value-import cycles, and
// ratchets the ranked target-spine back-edges so existing debt can only shrink.

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  backEdgePair,
  compareBackEdgeBaseline,
  countBackEdges,
  findValueImportCycles,
  resolveImportEdges,
  topFolder,
  type BackEdgeBaseline,
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
const baselinePath = path.join(repoRoot, 'scripts/layering/back-edge-baseline.json');

function listSourceFiles(): string[] {
  const out = execFileSync('git', ['ls-files', 'src/**/*.ts'], {
    cwd: repoRoot,
    encoding: 'utf8',
  });
  return out
    .split('\n')
    .filter(Boolean)
    .filter((file) => !/(?:^|\/)__tests__\//.test(file) && !/\.test\.ts$/.test(file));
}

function readSources(files: readonly string[]): Map<string, string> {
  return new Map(files.map((file) => [file, fs.readFileSync(path.join(repoRoot, file), 'utf8')]));
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

function readBaseline(): BackEdgeBaseline {
  if (!fs.existsSync(baselinePath)) {
    throw new Error(
      `Missing ${path.relative(repoRoot, baselinePath)}. Run pnpm check:layering:baseline.`,
    );
  }
  return JSON.parse(fs.readFileSync(baselinePath, 'utf8')) as BackEdgeBaseline;
}

function writeBaseline(actual: BackEdgeBaseline): void {
  fs.writeFileSync(baselinePath, `${JSON.stringify(actual, null, 2)}\n`);
  process.stdout.write(
    `Layering guard: updated ${path.relative(repoRoot, baselinePath)} with current back-edge counts.\n`,
  );
}

function checkBackEdgeRatchet(
  edges: readonly ResolvedImportEdge[],
  actual: BackEdgeBaseline,
): Violation[] {
  const baseline = readBaseline();
  return compareBackEdgeBaseline(baseline, actual).map((drift) => {
    const representative = edges.find((edge) => backEdgePair(edge) === drift.pair);
    const direction = drift.actual > drift.baseline ? 'grew' : 'shrunk';
    return {
      rule: 'R5 back-edge-ratchet',
      file: representative?.file ?? path.relative(repoRoot, baselinePath),
      line: representative?.line ?? 1,
      message:
        `${drift.pair} ${direction}: baseline ${drift.baseline}, current ${drift.actual}. ` +
        (direction === 'grew'
          ? `Remove the new up-edge; the target-spine debt may not increase.`
          : `Regenerate the baseline so the improvement becomes the new ceiling.`),
    };
  });
}

function report(files: readonly string[], violations: readonly Violation[]): number {
  if (violations.length === 0) {
    process.stdout.write(
      `Layering guard: OK — ${files.length} source files satisfy R1-R3, contain no ` +
        `value-import cycles, and match the down-only back-edge baseline.\n`,
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

export function main(argv = process.argv.slice(2)): number {
  const sourceFiles = listSourceFiles();
  const edges = resolveImportEdges(readSources(sourceFiles));
  const violations = [...checkLayeringRules(edges), ...checkCycles(edges)];
  const actualBackEdges = countBackEdges(edges);
  if (argv.includes('--update-baseline')) {
    if (violations.length > 0) return report(sourceFiles, violations);
    writeBaseline(actualBackEdges);
  } else {
    violations.push(...checkBackEdgeRatchet(edges, actualBackEdges));
  }
  return report(sourceFiles, violations);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  process.exit(main());
}
