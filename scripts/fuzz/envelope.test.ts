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
import { describe, expect, it } from 'vitest';
import { CASE_GENERATION_INPUTS, NON_GENERATING_MODULES } from './envelope.ts';

const FUZZ_DIR = path.dirname(fileURLToPath(import.meta.url));

/** Roots of case generation: the arbitraries, the seeds, the loop, and the violation rule. */
const ROOTS = ['arbitraries.ts', 'generate.ts', 'targets.ts', 'invariant.ts'] as const;

function localImportsOf(file: string): string[] {
  const source = fs.readFileSync(path.join(FUZZ_DIR, file), 'utf8');
  return [...source.matchAll(/from '\.\/([\w-]+\.ts)'/g)].map((match) => match[1]!);
}

/**
 * Walk stops at a waived module: what a non-generating module imports cannot reach a case either
 * (the runner imports the target registry, which would otherwise drag the whole harness in).
 */
function generationClosure(): Set<string> {
  const seen = new Set<string>();
  const queue = [...ROOTS];
  while (queue.length > 0) {
    const file = queue.pop()!;
    if (seen.has(file)) continue;
    seen.add(file);
    if (file in NON_GENERATING_MODULES) continue;
    queue.push(...localImportsOf(file));
  }
  return seen;
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
