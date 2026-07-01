// Import-direction lint — enforces the folder DAG established by the Phase-5
// folder moves (see plans/perfect-shape.md §5.5).
//
// This generalizes the former inline "Layering Guard" CI grep (which only
// checked that src/daemon and src/platforms do not import src/commands) into a
// structured check over the resolved import graph.
//
// Target DAG (imports point DOWN, toward the kernel sink):
//   kernel ◄ platforms ◄ core ◄ commands ◄ { cli, client, daemon/server }
//   client ◄ daemon/client     remote, metro ◄ daemon/client
//   sdk = re-export barrels only
//
// That full DAG is a *target*. Several Phase-5 folder moves are still pending
// (the client/remote/metro extraction, the daemon/server split, and the utils
// dissolution), so the tree still contains legitimate back-edges between
// folders that have not yet been separated (e.g. platforms→core, commands→cli,
// utils→*). Enforcing the whole DAG today would require a mass import rewrite,
// which Phase 5 explicitly defers. This lint therefore enforces only the three
// invariants that the *completed* moves (kernel/, daemon/client/) already
// guarantee and that hold green today:
//
//   R1  kernel is the dependency sink — nothing under src/kernel/ imports
//       another zone, except a type-only re-export from src/contracts/ (the one
//       documented kernel→contracts type seam).
//   R2  the command surface is a floor — nothing below it (kernel, platforms,
//       core, daemon) imports src/commands/. Generalizes the former guard,
//       which covered only daemon + platforms.
//   R3  platforms/ is statically imported only at the interactor seam
//       (src/core/interactors/) and by the daemon server (src/daemon/ minus
//       src/daemon/client/). Everywhere else must reach platforms via a dynamic
//       import() or a type-only import, which preserves CLI cold-start.
//
// Dynamic `import('../platforms/*')` and `import type` are always allowed by R3.
//
// Run: node --experimental-strip-types scripts/layering/check.ts

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

type ImportEdge = {
  spec: string;
  dynamic: boolean;
  typeOnly: boolean;
  line: number;
};

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

function listSourceFiles(): string[] {
  const out = execFileSync('git', ['ls-files', 'src/**/*.ts'], {
    cwd: repoRoot,
    encoding: 'utf8',
  });
  return out
    .split('\n')
    .filter(Boolean)
    .filter((f) => !/(?:^|\/)__tests__\//.test(f) && !/\.test\.ts$/.test(f));
}

// The DAG node ("zone") a src-relative path belongs to: its first path segment
// under src/, e.g. src/core/interactors/apple.ts → "core".
function topFolder(rel: string): string {
  const match = /^src\/([^/]+)\//.exec(rel);
  return match ? match[1] : '(root)';
}

function isCoreInteractor(rel: string): boolean {
  return rel.startsWith('src/core/interactors/');
}

function isDaemonServer(rel: string): boolean {
  return rel.startsWith('src/daemon/') && !rel.startsWith('src/daemon/client/');
}

// sdk/ are the package's PUBLIC re-export barrels (§5.5 "sdk = re-export barrels
// only"). They legitimately re-export platform symbols as part of the public API,
// and are OFF the CLI cold path (not imported by bin.ts/cli), so exempting them
// from R3 does not regress cold-start — they sit above the internal DAG R3 governs.
function isSdkBarrel(rel: string): boolean {
  return rel.startsWith('src/sdk/');
}

// ── Import extraction ───────────────────────────────────────────────────────

function scanDynamicImports(line: string, lineNo: number): ImportEdge[] {
  const edges: ImportEdge[] = [];
  const re = /import\s*\(\s*['"]([^'"]+)['"]/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(line))) {
    edges.push({ spec: match[1]!, dynamic: true, typeOnly: false, line: lineNo });
  }
  return edges;
}

function scanSideEffectImport(line: string, lineNo: number): ImportEdge | null {
  const match = /^\s*import\s+['"]([^'"]+)['"]/.exec(line);
  return match ? { spec: match[1]!, dynamic: false, typeOnly: false, line: lineNo } : null;
}

// A `from '...'` clause on lines[i] (possibly the tail of a multi-line import).
// Walk back to the statement start to read the import/export keyword and whether
// it is a whole-statement `type` import.
function scanFromImport(lines: string[], i: number): ImportEdge | null {
  const fromMatch = /(?:^|[\s;}])from\s+['"]([^'"]+)['"]/.exec(lines[i]!);
  if (!fromMatch) return null;

  let start = i;
  while (start >= 0 && !/^\s*(?:import|export)\b/.test(lines[start]!)) {
    start--;
  }
  if (start < 0) return null;

  const typeOnly = /^\s*(?:import|export)\s+type\b/.test(lines[start]!);
  return { spec: fromMatch[1]!, dynamic: false, typeOnly, line: start + 1 };
}

function parseImports(source: string): ImportEdge[] {
  const lines = source.split('\n');
  const edges: ImportEdge[] = [];
  for (let i = 0; i < lines.length; i++) {
    edges.push(...scanDynamicImports(lines[i]!, i + 1));
    const sideEffect = scanSideEffectImport(lines[i]!, i + 1);
    if (sideEffect) {
      edges.push(sideEffect);
      continue;
    }
    const fromImport = scanFromImport(lines, i);
    if (fromImport) edges.push(fromImport);
  }
  return edges;
}

function resolveTargetZone(fromFile: string, spec: string): string | null {
  if (!spec.startsWith('.')) return null; // bare / external specifier
  const resolved = path.normalize(path.join(path.dirname(fromFile), spec));
  if (!resolved.startsWith('src/')) return null; // escapes src/
  return resolved;
}

// ── Rules ───────────────────────────────────────────────────────────────────

// R1 — kernel is the dependency sink.
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

// R2 — the command surface is a floor.
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

// R3 — platforms/ static value imports only at the interactor seam and the
// daemon server; everywhere else use a dynamic import() or a type-only import.
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

function checkFile(file: string): Violation[] {
  const source = fs.readFileSync(path.join(repoRoot, file), 'utf8');
  const fromTop = topFolder(file);
  const violations: Violation[] = [];
  for (const imp of parseImports(source)) {
    const target = resolveTargetZone(file, imp.spec);
    if (target === null) continue;
    const toTop = topFolder(target);
    if (toTop === fromTop) continue; // intra-zone imports are always fine
    const ctx: EdgeContext = { file, fromTop, toTop, imp };
    for (const rule of RULES) {
      const violation = rule(ctx);
      if (violation) violations.push(violation);
    }
  }
  return violations;
}

// ── Report ──────────────────────────────────────────────────────────────────

function report(files: string[], violations: Violation[]): number {
  if (violations.length === 0) {
    process.stdout.write(
      `Layering guard: OK — ${files.length} source files satisfy the import-direction DAG ` +
        `(R1 kernel-sink, R2 commands-floor, R3 platforms-seam).\n`,
    );
    return 0;
  }

  const byRule = new Map<string, Violation[]>();
  for (const v of violations) {
    const bucket = byRule.get(v.rule) ?? [];
    bucket.push(v);
    byRule.set(v.rule, bucket);
  }

  process.stderr.write(`Layering guard: ${violations.length} import-direction violation(s)\n\n`);
  for (const [rule, group] of byRule) {
    process.stderr.write(`  [${rule}] ${group.length} violation(s):\n`);
    for (const v of group) {
      process.stderr.write(`    ${v.file}:${v.line} — ${v.message}\n`);
      process.stderr.write(
        `::error file=${v.file},line=${v.line},title=Layering drift (${v.rule})::${v.message}\n`,
      );
    }
    process.stderr.write('\n');
  }
  return 1;
}

const sourceFiles = listSourceFiles();
const allViolations = sourceFiles.flatMap(checkFile);
process.exit(report(sourceFiles, allViolations));
