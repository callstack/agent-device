// The run envelope's provenance guarantees (#1414, #1781 B2).
//
// `configHash` exists so "the same seed means different inputs now" is distinguishable from "the
// parsers changed": a stale corpus that reads as confidence is the failure it prevents. That only
// holds while the hash covers every module deciding what a case contains — and the domain split
// broke it silently, because the modules it hashed stopped being where generation lived. This
// test derives the answer from the import graph instead of trusting a hand-kept list.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { genBFS } from '@statelyai/graph';
import { describe, expect, it } from 'vitest';
import { parseImports } from '../layering/model.ts';
import { importGraphFromResolvedEdges, STATIC_EDGES } from '../depgraph/import-graph.ts';
import { CASE_GENERATION_INPUTS, NON_GENERATING_MODULES } from './envelope.ts';

const FUZZ_DIR = path.dirname(fileURLToPath(import.meta.url));

/** Roots of case generation: the arbitraries, the seeds, the loop, and the violation rule. */
const ROOTS = ['arbitraries.ts', 'generate.ts', 'targets.ts', 'invariant.ts'] as const;

function generationGraph() {
  const sources = new Map(
    fs
      .readdirSync(FUZZ_DIR)
      .filter((file) => file.endsWith('.ts'))
      .map((file) => [file, fs.readFileSync(path.join(FUZZ_DIR, file), 'utf8')]),
  );
  const edges = [];
  for (const [file, source] of sources) {
    if (file in NON_GENERATING_MODULES) continue;
    for (const edge of parseImports(source)) {
      if (!edge.spec.startsWith('./')) continue;
      const target = path.posix.normalize(path.posix.join(path.posix.dirname(file), edge.spec));
      if (!sources.has(target)) continue;
      edges.push({ file, target, dynamic: edge.dynamic, typeOnly: edge.typeOnly });
    }
  }
  return importGraphFromResolvedEdges(edges, STATIC_EDGES, sources.keys());
}

const graph = generationGraph();

/**
 * Walk stops at a waived module: what a non-generating module imports cannot reach a case either
 * (the runner imports the target registry, which would otherwise drag the whole harness in).
 */
function generationClosure(): Set<string> {
  return new Set([...genBFS(graph, { from: ROOTS })].map(({ id }) => id));
}

describe('configHash coverage', () => {
  it('hashes every module reachable from the generation roots, or waives it with a reason', () => {
    const covered = new Set<string>([
      ...CASE_GENERATION_INPUTS,
      ...Object.keys(NON_GENERATING_MODULES),
    ]);
    const uncovered = [...generationClosure()].filter((file) => !covered.has(file)).sort();
    expect(uncovered).toEqual([]);
  });

  it('waives nothing it also hashes, nothing unreachable, and explains every waiver', () => {
    const closure = generationClosure();
    for (const [file, reason] of Object.entries(NON_GENERATING_MODULES)) {
      expect(CASE_GENERATION_INPUTS).not.toContain(file);
      // A waiver for a module the roots no longer reach is dead configuration, and dead
      // configuration is how the next reader learns the wrong thing about what is covered.
      expect(closure, `${file} is waived but unreachable`).toContain(file);
      expect(reason.trim().length).toBeGreaterThan(10);
    }
  });

  it('lists only files that exist, so a renamed module fails here rather than hashing nothing', () => {
    for (const file of [...CASE_GENERATION_INPUTS, ...Object.keys(NON_GENERATING_MODULES)]) {
      expect(fs.existsSync(path.join(FUZZ_DIR, file)), file).toBe(true);
    }
  });
});
