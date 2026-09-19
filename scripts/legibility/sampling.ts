// Deterministic stratified sampling: proportional to family size, at least one file per family,
// seeded so the same seed always picks the same files. The chosen ids are recorded in the
// report, so a number can be reproduced or compared file-for-file.

import type { Corpus, CorpusFile } from './corpus.ts';

export const DEFAULT_SAMPLE_SIZE = 300;
export const DEFAULT_SEED = 2677;

/** mulberry32: a small seeded PRNG, enough for reproducible shuffles. */
export function seededRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function shuffled<T>(items: readonly T[], random: () => number): T[] {
  const out = [...items];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [out[i], out[j]] = [out[j]!, out[i]!];
  }
  return out;
}

/** Per-family quota: floor of the proportional share, at least one, largest remainders first. */
export function allocateQuotas(
  sizes: ReadonlyMap<string, number>,
  total: number,
): Map<string, number> {
  const files = [...sizes.values()].reduce((sum, n) => sum + n, 0);
  const families = [...sizes.keys()].sort();
  const quotas = new Map<string, number>();
  const remainders: [string, number][] = [];
  let assigned = 0;
  for (const family of families) {
    const exact = (total * sizes.get(family)!) / files;
    const quota = Math.max(1, Math.min(sizes.get(family)!, Math.floor(exact)));
    quotas.set(family, quota);
    remainders.push([family, exact - quota]);
    assigned += quota;
  }
  remainders.sort(([a, x], [b, y]) => y - x || a.localeCompare(b));
  for (const [family] of remainders) {
    if (assigned >= total) break;
    if (quotas.get(family)! < sizes.get(family)!) {
      quotas.set(family, quotas.get(family)! + 1);
      assigned += 1;
    }
  }
  for (const [family] of [...remainders].reverse()) {
    if (assigned <= total) break;
    if (quotas.get(family)! > 1) {
      quotas.set(family, quotas.get(family)! - 1);
      assigned -= 1;
    }
  }
  return quotas;
}

export function stratifiedSample(corpus: Corpus, size: number, seed: number): CorpusFile[] {
  if (size >= corpus.files.length) return [...corpus.files];
  const byFamily = new Map<string, CorpusFile[]>();
  for (const file of corpus.files) {
    const list = byFamily.get(file.family) ?? [];
    list.push(file);
    byFamily.set(file.family, list);
  }
  const quotas = allocateQuotas(
    new Map([...byFamily].map(([family, files]) => [family, files.length])),
    size,
  );
  const random = seededRandom(seed);
  const picked: CorpusFile[] = [];
  for (const family of [...byFamily.keys()].sort()) {
    picked.push(...shuffled(byFamily.get(family)!, random).slice(0, quotas.get(family)!));
  }
  return picked.sort((a, b) => a.id.localeCompare(b.id));
}
